import { inSubnet, ipOf, parseCidr, parseIPv4 } from './ipv4';
import { LINUX_IMAGES, type OsFamily } from './lab-catalog';
import type { LabIssue, LabSpec, MachineSpec, TargetInventory, WindowsSpec } from './lab-types';

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const FQDN = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const NETBIOS = /^[A-Za-z0-9][A-Za-z0-9-]{0,14}$/;
const LINUX_USER = /^[a-z_][a-z0-9_-]{0,31}$/;

export const passwordClasses = (pw: string) =>
  [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].reduce((n, re) => n + (re.test(pw) ? 1 : 0), 0);

// ───── effective settings (machine override → lab default) ─────

export const effectivePassword = (spec: LabSpec, m: MachineSpec) => m.credentials?.password || spec.defaults.password;
export const effectiveSshKey = (spec: LabSpec, m: MachineSpec) => (m.credentials?.sshKey || spec.defaults.sshKey).trim();
export const effectiveUsername = (spec: LabSpec, m: MachineSpec) => m.credentials?.username || spec.defaults.username;
export const effectiveBridge = (spec: LabSpec, m: MachineSpec) => m.net.bridge || spec.target.bridge;
export const splitList = (s: string | undefined) => (s ?? '').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);

export function findDc(spec: LabSpec, m: MachineSpec): WindowsSpec | undefined {
  const id = m.kind === 'linux-vm' || (m.kind === 'windows' && m.role === 'server') ? m.joinDomainOf : undefined;
  if (!id) return undefined;
  const dc = spec.machines.find((x) => x.id === id);
  return dc?.kind === 'windows' && dc.role === 'dc' ? dc : undefined;
}

export const linuxFamily = (m: Extract<MachineSpec, { kind: 'linux-vm' }>): OsFamily =>
  m.source.type === 'catalog' ? LINUX_IMAGES[m.source.image].family : m.source.family;

export function kindLabel(m: MachineSpec): string {
  switch (m.kind) {
    case 'linux-vm':
      return 'Linux VM';
    case 'lxc':
      return 'Container';
    case 'windows':
      return m.role === 'dc' ? 'Domain controller' : 'Windows Server';
    case 'esxi':
      return 'ESXi host';
  }
}

type AnySource =
  | { type: 'template'; vmid: number }
  | { type: 'backup'; volid: string }
  | { type: 'disk'; volid: string }
  | { type: 'vztmpl'; volid: string }
  | { type: 'catalog' }
  | { type: 'iso' };

/** Checks that a template / backup / disk / container template exists and is the right guest type. */
function checkGuestSource(s: AnySource, want: 'qemu' | 'lxc', inv: TargetInventory | undefined, err: (msg: string) => void) {
  const what = want === 'qemu' ? 'VM' : 'container';
  switch (s.type) {
    case 'template': {
      if (!s.vmid) return err('Choose a template.');
      const t = inv?.vmTemplates.find((x) => x.vmid === s.vmid);
      if (inv && !t) err(`Template ${s.vmid} wasn't found in the cluster.`);
      else if (t && t.type !== want) err(`Template ${s.vmid} is a ${t.type === 'qemu' ? 'VM' : 'container'}, not a ${what}.`);
      return;
    }
    case 'backup': {
      if (!s.volid) return err('Choose a backup.');
      const b = inv?.backups.find((x) => x.volid === s.volid);
      if (inv && !b) err(`${s.volid} isn't visible from ${inv.node}.`);
      else if (b && b.subtype !== want) err(`That backup is of a ${b.subtype === 'qemu' ? 'VM' : 'container'}, not a ${what}.`);
      return;
    }
    case 'disk':
      if (!s.volid) return err('Choose a disk image.');
      if (inv && !inv.diskImages.some((v) => v.volid === s.volid)) err(`${s.volid} isn't visible from ${inv.node}.`);
      return;
    case 'vztmpl':
      if (!s.volid) return err('Choose a container template from storage.');
      if (inv && !inv.lxcTemplates.some((v) => v.volid === s.volid)) err(`${s.volid} isn't visible from ${inv.node}.`);
      return;
    default:
      return;
  }
}

/** Every check that can be made without talking to Proxmox; `inv` adds target-aware checks. */
export function validateLab(spec: LabSpec, inv?: TargetInventory): LabIssue[] {
  const out: LabIssue[] = [];
  const err = (message: string, machine?: string, field?: string) => out.push({ level: 'error', message, machine, field });
  const warn = (message: string, machine?: string, field?: string) => out.push({ level: 'warning', message, machine, field });

  if (!spec.name.trim()) err('Give the lab a name.', undefined, 'name');
  if (!spec.target.conn) err('Choose a Proxmox connection to deploy to.');
  else if (!spec.target.node) err('Choose the node to deploy to.');
  if (spec.machines.length === 0) err('Add at least one machine.');

  const names = new Map<string, string>();
  const ips = new Map<string, string>();
  const usedNames = new Set((inv?.usedNames ?? []).map((n) => n.toLowerCase()));
  const usedIps = new Set(inv?.usedIps ?? []);

  for (const m of spec.machines) {
    const id = m.id;
    const name = m.name.trim();

    // ── identity
    if (!HOSTNAME.test(name)) err(`"${name || '(blank)'}" isn't a valid host name — use letters, digits and hyphens.`, id, 'name');
    else if (/^\d+$/.test(name)) err('A host name can\'t be all digits.', id, 'name');
    if (m.kind === 'windows' && name.length > 15) err('Windows computer names can be at most 15 characters.', id, 'name');
    const key = name.toLowerCase();
    if (names.has(key)) err(`Two machines are called "${name}".`, id, 'name');
    names.set(key, id);
    if (usedNames.has(key)) warn(`A guest called "${name}" already exists on this cluster.`, id, 'name');

    // Active Directory computer accounts (sAMAccountName) hold 15 characters: longer names collide once cut.
    const joins = (m.kind === 'linux-vm' || m.kind === 'windows') && m.joinDomainOf ? findDc(spec, m) : undefined;
    if (joins && m.kind === 'linux-vm' && name.length > 15) err('Machines that join a domain can have names of at most 15 characters.', id, 'name');
    if (joins?.domain?.netbios && joins.domain.netbios.trim().toUpperCase() === name.toUpperCase())
      err('A machine can\'t have the same name as the domain it joins (NetBIOS name).', id, 'name');

    // ── resources (also catches blank fields, which arrive as NaN or null)
    if (!(Number.isInteger(m.cores) && m.cores >= 1 && m.cores <= 512)) err('CPU cores must be a whole number from 1 to 512.', id, 'cores');
    if (!(Number.isInteger(m.memoryMiB) && m.memoryMiB > 0)) err('Memory must be a whole number of MiB.', id, 'memoryMiB');
    if (!(Number.isInteger(m.diskGiB) && m.diskGiB >= 1)) err('Disk size must be a whole number of GiB, at least 1.', id, 'diskGiB');

    // ── credentials
    const pw = effectivePassword(spec, m);
    const key2 = effectiveSshKey(spec, m);
    if (m.kind === 'windows' || m.kind === 'esxi') {
      if (!pw) err('Set a password (lab default or this machine).', id, 'password');
      else if (pw.length < 8 || passwordClasses(pw) < 3)
        err('Password needs 8+ characters with three of: lowercase, uppercase, digits, symbols.', id, 'password');
      if (m.kind === 'windows' && /administrator/i.test(pw)) err('Windows rejects passwords containing "Administrator".', id, 'password');
      if (m.kind === 'esxi' && /[\s#"]/.test(pw)) err('ESXi passwords can\'t contain spaces, # or ".', id, 'password');
    } else if (m.kind === 'linux-vm') {
      if (!pw && !key2) err('Set a password or an SSH key so you can log in.', id, 'password');
      const user = effectiveUsername(spec, m);
      if (!LINUX_USER.test(user)) err(`"${user}" isn't a valid Linux user name.`, id, 'username');
      else if (user === 'root') warn('Logging in directly as root is disabled on most cloud images — pick another user name.', id, 'username');
    } else if (m.kind === 'lxc') {
      if (pw && pw.length < 5) err('Container passwords need at least 5 characters.', id, 'password');
      if (!pw && !key2) err('Set a password or an SSH key so you can log in.', id, 'password');
    }

    // ── network
    const bridge = m.net.bridge || spec.target.bridge;
    if (inv && bridge && !inv.bridges.some((b) => b.name === bridge)) err(`Bridge ${bridge} doesn't exist on ${inv.node}.`, id, 'bridge');
    if (m.net.vlan !== undefined && !(Number.isInteger(m.net.vlan) && m.net.vlan >= 1 && m.net.vlan <= 4094)) err('VLAN tag must be a whole number from 1 to 4094.', id, 'vlan');
    if (m.net.ipMode === 'static') {
      const c = parseCidr(m.net.cidr);
      if (!c) err('Static address must look like 192.168.1.50/24.', id, 'cidr');
      else {
        if (c.prefix < 31 && (c.ip === c.network || c.ip === c.broadcast)) err('That address is the network or broadcast address.', id, 'cidr');
        const ip = ipOf(m.net.cidr!);
        if (ips.has(ip)) err(`${ip} is used by two machines.`, id, 'cidr');
        ips.set(ip, id);
        if (usedIps.has(ip)) warn(`${ip} looks like it's already in use (by an existing guest, the Proxmox host or another lab).`, id, 'cidr');
        if (m.net.gateway) {
          if (parseIPv4(m.net.gateway) === null) err('Gateway must be an IPv4 address.', id, 'gateway');
          else if (!inSubnet(m.net.gateway, c)) err(`Gateway ${m.net.gateway} isn't in ${m.net.cidr}.`, id, 'gateway');
        } else warn('No gateway — this machine won\'t reach other networks or the internet.', id, 'gateway');
      }
    }
    for (const d of splitList(m.net.dns)) if (parseIPv4(d) === null) err(`DNS server "${d}" isn't an IPv4 address.`, id, 'dns');

    // ── kind-specific
    switch (m.kind) {
      case 'linux-vm': {
        if (m.memoryMiB < 256) err('Give it at least 256 MiB of memory.', id, 'memoryMiB');
        if (m.diskGiB < 4) err('Cloud images need at least 4 GiB of disk.', id, 'diskGiB');
        const s = m.source;
        checkGuestSource(s, 'qemu', inv, (msg) => err(msg, id, 'source'));
        if ((s.type === 'catalog' || s.type === 'disk') && inv && !inv.features.importImages)
          err('Importing disk images needs Proxmox VE 8.3 or newer — choose a template or backup instead.', id, 'source');
        // (That boxes need cloud-init is explained next to the source picker — not an issue on every card.)
        if (s.type === 'catalog') warn('Downloading a cloud image only works if the Proxmox node has internet access.', id, 'source');
        if (m.packages.length) warn('Extra packages need a package repository the VM can reach (e.g. an internal mirror).', id, 'packages');
        if (m.net.ipMode === 'dhcp')
          warn('With DHCP, ProxFlow can only find this machine if its image has the QEMU guest agent. A static IP lets it check SSH instead.', id, 'cidr');
        if (m.joinDomainOf) {
          const dc = findDc(spec, m);
          if (!dc) err('The domain controller this machine joins is no longer in the lab.', id, 'join');
          else {
            if (m.net.ipMode === 'dhcp' && linuxFamily(m) === 'rhel')
              err('To join a domain, Rocky/Alma machines need a static IP (DNS must point at the domain controller).', id, 'cidr');
            warn('Joining AD from Linux needs realmd, sssd and adcli already in the image (nothing can be installed offline).', id, 'join');
          }
        }
        break;
      }
      case 'lxc': {
        if (m.memoryMiB < 64) err('Give it at least 64 MiB of memory.', id, 'memoryMiB');
        checkGuestSource(m.source, 'lxc', inv, (msg) => err(msg, id, 'source'));
        if (!m.unprivileged && m.nesting)
          warn('Proxmox only lets root@pam with a password (not an API token) turn on nesting for a privileged container.', id, 'nesting');
        break;
      }
      case 'windows': {
        if (m.memoryMiB < 2048) err('Windows Server needs at least 2 GiB of memory.', id, 'memoryMiB');
        else if (m.memoryMiB < 4096) warn('4 GiB or more is recommended for Windows Server.', id, 'memoryMiB');
        if (m.diskGiB < 32) err('Windows Server needs at least 32 GiB of disk.', id, 'diskGiB');
        else if (m.diskGiB < 50) warn('50 GiB or more is recommended for Windows Server.', id, 'diskGiB');
        const src = m.source;
        if (src.type !== 'iso') {
          // (Boxes being configured via the guest agent is explained next to the source picker.)
          checkGuestSource(src, 'qemu', inv, (msg) => err(msg, id, 'source'));
        } else if (!src.iso) err('Choose the Windows Server installer ISO.', id, 'iso');
        else if (inv && !inv.isos.some((v) => v.volid === src.iso)) err(`${src.iso} isn't visible from ${inv.node}.`, id, 'iso');
        if (src.type === 'iso' && inv && !inv.virtioIso) {
          warn(
            'No VirtIO driver ISO (virtio-win*.iso) on storage — Windows will use slower built-in SATA/Intel drivers and has no guest agent.',
            id,
            'iso',
          );
          if (m.net.ipMode === 'dhcp') warn('Without the guest agent and with DHCP, ProxFlow can\'t tell when this machine is ready.', id, 'cidr');
        }
        if (m.role === 'dc') {
          if (m.net.ipMode !== 'static') err('A domain controller needs a static IP — other machines point their DNS at it.', id, 'cidr');
          const fqdn = m.domain?.fqdn?.trim() ?? '';
          if (!FQDN.test(fqdn)) err('Domain name must have at least two parts, e.g. lab.internal.', id, 'domain');
          else if (/\.local$/i.test(fqdn)) warn('Microsoft recommends against .local domains — consider lab.internal.', id, 'domain');
          const nb = m.domain?.netbios?.trim() ?? '';
          if (!NETBIOS.test(nb)) err('NetBIOS domain name: up to 15 letters, digits or hyphens.', id, 'netbios');
          else if (nb.toUpperCase() === name.toUpperCase()) err('The NetBIOS domain name must differ from the computer name.', id, 'netbios');
        } else if (m.joinDomainOf && !findDc(spec, m)) err('The domain controller this machine joins is no longer in the lab.', id, 'join');
        break;
      }
      case 'esxi': {
        if (!m.iso) err('Choose the ESXi installer ISO.', id, 'iso');
        else if (inv && !inv.isos.some((v) => v.volid === m.iso)) err(`${m.iso} isn't visible from ${inv.node}.`, id, 'iso');
        if (m.net.ipMode !== 'static') err('ESXi needs a static IP here — ProxFlow uses it to confirm the install finished.', id, 'cidr');
        if (m.cores < 2) err('ESXi needs at least 2 cores.', id, 'cores');
        if (m.memoryMiB < 4096) err('ESXi needs at least 4 GiB of memory (8 GiB for ESXi 8).', id, 'memoryMiB');
        else if (m.memoryMiB < 8192) warn('ESXi 8 requires 8 GiB of memory.', id, 'memoryMiB');
        if (m.diskGiB < 32) err('ESXi needs at least 32 GiB of disk.', id, 'diskGiB');
        break;
      }
    }
  }

  // ── target-level checks
  if (inv && spec.machines.length) {
    const st = (name: string) => inv.storages.find((s) => s.name === name);
    const needs = (kinds: MachineSpec['kind'][]) => spec.machines.some((m) => kinds.includes(m.kind));
    const disk = st(spec.target.diskStorage);
    if (!disk) err('Choose a storage for VM disks.');
    else {
      if (needs(['linux-vm', 'windows', 'esxi']) && !disk.content.includes('images')) err(`Storage ${disk.name} can't hold VM disks.`);
      if (needs(['lxc']) && !disk.content.includes('rootdir')) err(`Storage ${disk.name} can't hold container volumes.`);
    }
    if (needs(['linux-vm', 'windows', 'esxi'])) {
      const iso = st(spec.target.isoStorage);
      if (!iso) err('Choose a storage for ProxFlow\'s setup ISOs.');
      else if (!iso.content.includes('iso')) err(`Storage ${iso.name} doesn't allow ISO images.`);
    }
    if (spec.machines.some((m) => m.kind === 'linux-vm' && m.source.type === 'catalog')) {
      const imp = st(spec.target.importStorage);
      if (!imp) err('Choose a storage for downloaded cloud images.');
      else if (!imp.content.includes('import'))
        out.push({
          level: 'error',
          message: `Storage ${imp.name} doesn't allow "Import" content, which cloud-image downloads need.`,
          fix: { kind: 'enable-content', storage: imp.name, content: 'import', label: `Enable Import on ${imp.name}` },
        });
    }
    const n = inv.nodes.find((x) => x.name === spec.target.node);
    const memNeed = spec.machines.reduce((a, m) => a + m.memoryMiB * 1024 ** 2, 0);
    if (n && memNeed > n.maxmem - n.mem)
      warn(`The lab needs ${(memNeed / 1024 ** 3).toFixed(1)} GiB of RAM; ${n.name} has about ${((n.maxmem - n.mem) / 1024 ** 3).toFixed(1)} GiB free.`);
    const diskNeed = spec.machines.reduce((a, m) => a + m.diskGiB * 1024 ** 3, 0);
    if (disk && disk.avail > 0 && diskNeed > disk.avail)
      warn(`The lab's disks add up to ${(diskNeed / 1024 ** 3).toFixed(0)} GiB; ${disk.name} has ${(disk.avail / 1024 ** 3).toFixed(0)} GiB free (thin storage may still fit).`);
    if (spec.machines.some((m) => m.kind === 'esxi'))
      warn(
        'Nested ESXi needs nested virtualization on the Proxmox host: cat /sys/module/kvm_intel/parameters/nested (Intel) or /sys/module/kvm_amd/parameters/nested (AMD) should print Y or 1.',
      );
  }

  return out;
}
