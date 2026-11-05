import { AppWindow, Container, Landmark, Server, Terminal, type LucideIcon } from 'lucide-react';
import { LINUX_IMAGES, WINDOWS_VERSIONS, type MachineSpec, type TargetInventory } from '@proxflow/shared';
import type { PaletteKind } from './design';

export type KindStyle = { label: string; icon: LucideIcon; tint: string; ring: string };

export const KIND_STYLES: Record<PaletteKind, KindStyle> = {
  'windows-dc': { label: 'Domain controller', icon: Landmark, tint: 'bg-violet-500/15 text-violet-300', ring: 'border-violet-500/40' },
  'windows-server': { label: 'Windows Server', icon: AppWindow, tint: 'bg-sky-500/15 text-sky-300', ring: 'border-sky-500/40' },
  'linux-vm': { label: 'Linux VM', icon: Terminal, tint: 'bg-emerald-500/15 text-emerald-300', ring: 'border-emerald-500/40' },
  lxc: { label: 'Container', icon: Container, tint: 'bg-teal-500/15 text-teal-300', ring: 'border-teal-500/40' },
  esxi: { label: 'ESXi host', icon: Server, tint: 'bg-amber-500/15 text-amber-300', ring: 'border-amber-500/40' },
};

export const paletteKindOf = (m: MachineSpec): PaletteKind => (m.kind === 'windows' ? (m.role === 'dc' ? 'windows-dc' : 'windows-server') : m.kind);

const fileOf = (volid: string) => volid.slice(volid.indexOf(':') + 1).replace(/^(iso|import|vztmpl|backup)\//, '');
const short = (s: string, n = 34) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Human-readable "where this machine comes from", resolved against what's on storage. */
export function describeSource(m: MachineSpec, inv?: TargetInventory): string {
  const backup = (volid: string) => {
    const b = inv?.backups.find((x) => x.volid === volid);
    return `Box: ${short(b?.notes ?? fileOf(volid))}`;
  };
  const template = (vmid: number) => {
    const t = inv?.vmTemplates.find((x) => x.vmid === vmid);
    if (t?.box) return `Box: ${short(t.name, 26)} (restored)`; // a backup ProxFlow restored earlier
    return `Template ${vmid}${t ? `: ${short(t.name, 24)}` : ''}${t && inv && t.node !== inv.node ? ` (on ${t.node})` : ''}`;
  };
  switch (m.kind) {
    case 'linux-vm': {
      const s = m.source;
      if (s.type === 'backup') return backup(s.volid);
      if (s.type === 'template') return template(s.vmid);
      if (s.type === 'disk') return `Disk: ${short(fileOf(s.volid))}`;
      return `Download: ${LINUX_IMAGES[s.image].label}`;
    }
    case 'lxc':
      return m.source.type === 'backup' ? backup(m.source.volid) : `CT template: ${short(fileOf(m.source.volid) || '—')}`;
    case 'windows': {
      const s = m.source;
      if (s.type === 'iso') return `ISO install · ${WINDOWS_VERSIONS[s.version].label.replace('Windows ', '')}`;
      return s.type === 'backup' ? backup(s.volid) : template(s.vmid);
    }
    case 'esxi':
      return m.iso ? `ISO: ${short(fileOf(m.iso))}` : 'ISO: not chosen';
  }
}

export const fmtMem = (mib: number) => (mib >= 1024 ? `${+(mib / 1024).toFixed(1)} GiB` : `${mib} MiB`);
