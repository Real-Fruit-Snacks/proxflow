/**
 * The lab as designed on the canvas (persisted in this browser), plus factories that pick
 * sensible defaults from what's already on Proxmox storage — offline-first.
 */
import {
  guessFamily,
  ipOf,
  looksLikeEsxiIso,
  looksLikeWindowsIso,
  suggestStaticIps,
  type Connection,
  type LabDefaults,
  type LabSpec,
  type LabTarget,
  type LinuxSource,
  type LxcSource,
  type MachineSpec,
  type NetSpec,
  type TargetInventory,
  type WindowsSource,
  type WindowsVersionId,
} from '@proxflow/shared';

export type PaletteKind = 'windows-dc' | 'windows-server' | 'linux-vm' | 'lxc' | 'esxi';
export type DesignMachine = MachineSpec & { position: { x: number; y: number } };
export type LabDesign = {
  version: 1;
  name: string;
  target: Partial<LabTarget>;
  defaults: LabDefaults;
  machines: DesignMachine[];
  activeDeployment?: string;
};

const STORAGE_KEY = 'proxflow.lab.v1';

// ───────────────────────── persistence ─────────────────────────

/** Readable but strong: "Lab-k7mq-3vxt!" — satisfies Windows and ESXi complexity, no spaces/#/". */
export function generatePassword(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  const rnd = crypto.getRandomValues(new Uint32Array(8));
  const pick = (i: number) => chars[rnd[i]! % chars.length];
  const part = (o: number) => [0, 1, 2, 3].map((i) => pick(o + i)).join('');
  let pw = `Lab-${part(0)}-${part(4)}!`;
  if (!/\d/.test(pw)) pw = pw.replace('!', '7!');
  return pw;
}

export function emptyDesign(): LabDesign {
  return { version: 1, name: 'My lab', target: {}, defaults: { username: 'labadmin', password: generatePassword(), sshKey: '', dns: '' }, machines: [] };
}

export function loadDesign(): LabDesign {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const d = JSON.parse(raw) as LabDesign;
      if (d?.version === 1 && Array.isArray(d.machines) && d.defaults) return d;
    }
  } catch {
    /* corrupted → start fresh */
  }
  return emptyDesign();
}

export const saveDesign = (d: LabDesign) => localStorage.setItem(STORAGE_KEY, JSON.stringify(d));

const trimmed = <T extends string | undefined>(v: T): T => (typeof v === 'string' ? (v.trim() as T) : v);

/**
 * What the server gets. Typed values are trimmed here: validation trims before it checks, but the server
 * builds Proxmox settings from the raw text, so "10.0.0.5/24 " would pass review and fail mid-deploy.
 */
export function toSpec(d: LabDesign): LabSpec {
  const t = d.target;
  return {
    name: d.name.trim(),
    target: { conn: t.conn ?? '', node: t.node ?? '', diskStorage: t.diskStorage ?? '', isoStorage: t.isoStorage ?? '', importStorage: t.importStorage ?? '', bridge: t.bridge ?? '' },
    defaults: { ...d.defaults, username: d.defaults.username.trim(), sshKey: d.defaults.sshKey.trim(), dns: d.defaults.dns.trim() },
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    machines: d.machines.map(({ position, ...m }) => {
      const out = {
        ...m,
        name: m.name.trim(),
        net: { ...m.net, cidr: trimmed(m.net.cidr), gateway: trimmed(m.net.gateway), dns: trimmed(m.net.dns) },
        ...(m.credentials ? { credentials: { ...m.credentials, username: trimmed(m.credentials.username), sshKey: trimmed(m.credentials.sshKey) } } : {}),
      } as MachineSpec;
      if (out.kind === 'windows' && out.domain) out.domain = { fqdn: out.domain.fqdn.trim(), netbios: out.domain.netbios.trim() };
      return out;
    }),
  };
}

// ───────────────────────── target defaults ─────────────────────────

/** Fills in (or repairs) target fields from the inventory, keeping anything the user chose that still exists. */
export function fillTarget(target: Partial<LabTarget>, inv: TargetInventory): Partial<LabTarget> {
  const st = (name?: string) => inv.storages.find((s) => s.name === name && s.active);
  const firstWith = (c: string, prefer: string[] = []) =>
    prefer.map(st).find((s) => s?.content.includes(c))?.name ?? inv.storages.find((s) => s.active && s.content.includes(c))?.name;
  const t = { ...target, node: inv.node };
  if (!st(t.diskStorage)?.content.includes('images')) t.diskStorage = firstWith('images', ['local-lvm', 'local-zfs']);
  if (!st(t.isoStorage)?.content.includes('iso')) t.isoStorage = firstWith('iso', ['local']);
  if (!st(t.importStorage)) t.importStorage = st(t.isoStorage)?.content.includes('import') ? t.isoStorage : (firstWith('import') ?? t.isoStorage);
  if (!inv.bridges.some((b) => b.name === t.bridge)) t.bridge = inv.bridges.find((b) => b.name === 'vmbr0')?.name ?? inv.bridges[0]?.name;
  return t;
}

export const firstOkConnection = (cs: Connection[]) => cs.find((c) => c.status?.ok && c.enabled) ?? cs.find((c) => c.enabled);

// ───────────────────────── machine factories ─────────────────────────

const newId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function nextName(prefix: string, taken: string[]): string {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  for (let i = 1; ; i++) {
    const n = `${prefix}${String(i).padStart(2, '0')}`;
    if (!used.has(n)) return n;
  }
}

const isWindowsy = (s: string) => /win|w2k|server20|ws20/i.test(s);

/** Static IPs in the default bridge's subnet that nothing else in the lab or cluster uses. */
export function suggestIps(design: LabDesign, inv: TargetInventory | undefined, count: number): string[] {
  if (!inv) return [];
  const bridge = inv.bridges.find((b) => b.name === design.target.bridge) ?? inv.bridges[0];
  const used = [...inv.usedIps, ...design.machines.flatMap((m) => (m.net.cidr ? [ipOf(m.net.cidr)] : [])), ...(bridge?.gateway ? [bridge.gateway] : [])];
  return suggestStaticIps(bridge?.cidr, count, used);
}

function netFor(design: LabDesign, inv: TargetInventory | undefined): NetSpec {
  const bridge = inv?.bridges.find((b) => b.name === design.target.bridge) ?? inv?.bridges[0];
  const [cidr] = suggestIps(design, inv, 1);
  // Static by default: offline labs often lack DHCP, and a known IP lets ProxFlow confirm readiness without an agent.
  return cidr ? { ipMode: 'static', cidr, gateway: bridge?.gateway } : { ipMode: 'dhcp' };
}

export function windowsVersionFromIso(name: string): WindowsVersionId {
  if (/26100|2025/.test(name)) return '2025';
  if (/17763|2019/.test(name)) return '2019';
  return '2022';
}

function linuxSource(inv?: TargetInventory): LinuxSource {
  const backup = inv?.backups.find((b) => b.subtype === 'qemu' && !isWindowsy(`${b.notes ?? ''} ${b.name}`));
  if (backup) return { type: 'backup', volid: backup.volid, family: guessFamily(`${backup.notes ?? ''} ${backup.name}`) };
  const tpl = inv?.vmTemplates.find((t) => t.type === 'qemu' && !isWindowsy(t.name));
  if (tpl) return { type: 'template', vmid: tpl.vmid, family: guessFamily(tpl.name) };
  const disk = inv?.diskImages[0];
  if (disk) return { type: 'disk', volid: disk.volid, family: guessFamily(disk.name) };
  return { type: 'catalog', image: 'ubuntu-24.04' };
}

function windowsSource(inv: TargetInventory | undefined, preferBox: boolean): WindowsSource {
  const iso = inv?.isos.find((v) => looksLikeWindowsIso(v.name));
  const box = inv?.backups.find((b) => b.subtype === 'qemu' && isWindowsy(`${b.notes ?? ''} ${b.name}`));
  const tpl = inv?.vmTemplates.find((t) => t.type === 'qemu' && isWindowsy(t.name));
  if (preferBox && tpl) return { type: 'template', vmid: tpl.vmid };
  if (preferBox && box) return { type: 'backup', volid: box.volid };
  if (iso) return { type: 'iso', iso: iso.volid, version: windowsVersionFromIso(iso.name), edition: 'standard-desktop' };
  if (tpl) return { type: 'template', vmid: tpl.vmid };
  if (box) return { type: 'backup', volid: box.volid };
  return { type: 'iso', iso: '', version: '2022', edition: 'standard-desktop' };
}

function lxcSource(inv?: TargetInventory): LxcSource {
  const t = inv?.lxcTemplates.find((v) => /debian-12/.test(v.name)) ?? inv?.lxcTemplates[0];
  if (t) return { type: 'vztmpl', volid: t.volid };
  const b = inv?.backups.find((x) => x.subtype === 'lxc');
  return b ? { type: 'backup', volid: b.volid } : { type: 'vztmpl', volid: '' };
}

export function newMachine(kind: PaletteKind, design: LabDesign, inv: TargetInventory | undefined, position: { x: number; y: number }): DesignMachine {
  const taken = design.machines.map((m) => m.name);
  const net = netFor(design, inv);
  const base = { id: newId(), onboot: false, net, position };
  switch (kind) {
    case 'windows-dc': {
      const n = design.machines.filter((m) => m.kind === 'windows' && m.role === 'dc').length;
      const fqdn = n === 0 ? 'lab.internal' : `lab${n + 1}.internal`;
      return { ...base, kind: 'windows', role: 'dc', name: nextName('dc', taken), cores: 2, memoryMiB: 4096, diskGiB: 60, source: windowsSource(inv, false), domain: { fqdn, netbios: fqdn.split('.')[0]!.toUpperCase() } };
    }
    case 'windows-server': {
      const dcs = design.machines.filter((m) => m.kind === 'windows' && m.role === 'dc');
      return { ...base, kind: 'windows', role: 'server', name: nextName('ws', taken), cores: 2, memoryMiB: 4096, diskGiB: 60, source: windowsSource(inv, true), joinDomainOf: dcs.length === 1 ? dcs[0]!.id : undefined };
    }
    case 'linux-vm':
      return { ...base, kind: 'linux-vm', name: nextName('linux', taken), cores: 2, memoryMiB: 2048, diskGiB: 20, source: linuxSource(inv), packages: [] };
    case 'lxc':
      return { ...base, kind: 'lxc', name: nextName('ct', taken), cores: 1, memoryMiB: 512, diskGiB: 8, source: lxcSource(inv), unprivileged: true, nesting: true };
    case 'esxi':
      return { ...base, kind: 'esxi', name: nextName('esxi', taken), cores: 4, memoryMiB: 12288, diskGiB: 64, iso: inv?.isos.find((v) => looksLikeEsxiIso(v.name))?.volid ?? '' };
  }
}

// ───────────────────────── presets ─────────────────────────

export type Preset = { id: string; label: string; description: string; name: string; kinds: { kind: PaletteKind; x: number; y: number }[] };

export const PRESETS: Preset[] = [
  {
    id: 'one',
    label: 'Start with one machine',
    description: 'A single Linux VM from the first box on storage.',
    name: 'Sandbox',
    kinds: [{ kind: 'linux-vm', x: 0, y: 0 }],
  },
  {
    id: 'ad',
    label: 'Active Directory lab',
    description: 'Domain controller, two member servers and a Linux VM.',
    name: 'AD lab',
    kinds: [
      { kind: 'windows-dc', x: 272, y: 0 },
      { kind: 'windows-server', x: 0, y: 200 },
      { kind: 'windows-server', x: 272, y: 200 },
      { kind: 'linux-vm', x: 544, y: 200 },
    ],
  },
  {
    id: 'linux',
    label: 'Linux servers',
    description: 'Three Linux VMs from your boxes.',
    name: 'Linux lab',
    kinds: [
      { kind: 'linux-vm', x: 0, y: 0 },
      { kind: 'linux-vm', x: 272, y: 0 },
      { kind: 'linux-vm', x: 544, y: 0 },
    ],
  },
  {
    id: 'esxi',
    label: 'Nested ESXi',
    description: 'Two ESXi hosts from the installer ISO.',
    name: 'ESXi lab',
    kinds: [
      { kind: 'esxi', x: 0, y: 0 },
      { kind: 'esxi', x: 272, y: 0 },
    ],
  },
  {
    id: 'containers',
    label: 'Containers',
    description: 'Three lightweight containers.',
    name: 'Container lab',
    kinds: [
      { kind: 'lxc', x: 0, y: 0 },
      { kind: 'lxc', x: 272, y: 0 },
      { kind: 'lxc', x: 544, y: 0 },
    ],
  },
];

/** Builds a preset machine by machine so names, IPs and the domain link come out right. */
export function applyPreset(design: LabDesign, preset: Preset, inv: TargetInventory | undefined): LabDesign {
  // (activeDeployment stays: a running lab must keep its Cancel / Destroy panel.)
  let d: LabDesign = { ...design, name: preset.name, machines: [] };
  for (const k of preset.kinds) {
    const m = newMachine(k.kind, d, inv, { x: k.x, y: k.y });
    if (m.kind === 'linux-vm' && preset.id === 'ad') {
      const dc = d.machines.find((x) => x.kind === 'windows' && x.role === 'dc');
      if (dc) m.joinDomainOf = dc.id;
    }
    d = { ...d, machines: [...d.machines, m] };
  }
  return d;
}
