/** Parsers for Proxmox's "key=value,key=value" config strings (net0, scsi0, rootfs, mp0 …). */
import type { DiskRef, GuestType, NetIface } from '@proxflow/shared';
import type { RawGuestConfig } from './types.js';

export function parseKv(value: string): { positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (const part of value.split(',')) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf('=');
    if (eq === -1) positional.push(p);
    else opts[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return { positional, opts };
}

const NIC_MODELS = [
  'virtio', 'e1000', 'e1000e', 'e1000-82540em', 'e1000-82544gc', 'e1000-82545em',
  'vmxnet3', 'rtl8139', 'ne2k_pci', 'ne2k_isa', 'pcnet', 'i82551', 'i82557b', 'i82559er',
];

export function parseNets(type: GuestType, cfg: RawGuestConfig): NetIface[] {
  const out: NetIface[] = [];
  for (const [key, raw] of Object.entries(cfg)) {
    if (!/^net\d+$/.test(key) || typeof raw !== 'string') continue;
    const { opts } = parseKv(raw);
    const iface: NetIface = { key, bridge: opts.bridge, firewall: opts.firewall === '1' };
    if (opts.tag) iface.vlan = Number(opts.tag);
    if (type === 'qemu') {
      // qemu: "virtio=BC:24:11:…,bridge=vmbr0" — the model is the key of the MAC pair.
      const model = NIC_MODELS.find((m) => opts[m] !== undefined);
      if (model) {
        iface.model = model;
        iface.mac = opts[model];
      } else if (opts.macaddr) {
        iface.mac = opts.macaddr;
        iface.model = opts.model;
      }
    } else {
      iface.name = opts.name;
      iface.mac = opts.hwaddr;
      iface.ip = opts.ip;
      iface.gateway = opts.gw;
    }
    out.push(iface);
  }
  return out.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

const QEMU_DISK = /^(scsi|virtio|ide|sata|efidisk|tpmstate)\d+$/;
const LXC_DISK = /^(rootfs|mp\d+)$/;

export function parseDisks(type: GuestType, cfg: RawGuestConfig): DiskRef[] {
  const re = type === 'qemu' ? QEMU_DISK : LXC_DISK;
  const out: DiskRef[] = [];
  for (const [key, raw] of Object.entries(cfg)) {
    if (!re.test(key) || typeof raw !== 'string') continue;
    const { positional, opts } = parseKv(raw);
    const vol = positional[0];
    if (!vol || vol === 'none' || opts.media === 'cdrom') continue;
    // Passthrough devices ("/dev/sdb") and bind mounts ("/mnt/data") have no storage.
    if (vol.startsWith('/')) continue;
    const colon = vol.indexOf(':');
    if (colon <= 0) continue;
    out.push({
      key,
      storage: vol.slice(0, colon),
      volume: vol.slice(colon + 1),
      sizeGiB: parseSizeGiB(opts.size),
      mountPoint: opts.mp,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
}

/** "32G" → 32, "512M" → 0.5, "1T" → 1024. Bare numbers are bytes. */
export function parseSizeGiB(s?: string): number | undefined {
  if (!s) return undefined;
  const m = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(s.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? '').toUpperCase();
  const mult: Record<string, number> = { '': 1 / 1024 ** 3, K: 1 / 1024 ** 2, M: 1 / 1024, G: 1, T: 1024 };
  return Math.round(n * (mult[unit] ?? 1) * 1000) / 1000;
}
