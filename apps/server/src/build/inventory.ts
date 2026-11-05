/**
 * "What can I build from on this node?" — everything already on storage (local and shared):
 * ISOs, disk images, container templates, vzdump backups, VM/CT templates, plus bridges,
 * storages, free VMIDs and permissions. Nothing here downloads anything.
 */
import {
  isImportableDisk,
  looksLikeVirtioIso,
  versionAtLeast,
  type GuestType,
  type InventoryBackup,
  type InventoryVolume,
  type TargetInventory,
} from '@proxflow/shared';
import type { PveClient } from '../pve/client.js';
import { summarizePermissions, unknownPermissions } from '../pve/permissions.js';
import type { ClusterTopology } from '../pve/topology.js';
import type { RawGuestResource, RawNodeResource, RawPermissions, RawVolume } from '../pve/types.js';

export type InventoryBundle = { inv: TargetInventory; perms?: RawPermissions };

const MAX_BACKUPS = 200;
const MAX_BACKUP_CONFIG_READS = 40;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const fileName = (volid: string) => volid.slice(volid.indexOf(':') + 1).replace(/^(iso|import|vztmpl|backup)\//, '');

/** vzdump-qemu-… / vzdump-lxc-… files, or PBS "backup/vm/…" / "backup/ct/…" snapshots. */
function backupSubtype(v: RawVolume): GuestType | undefined {
  if (v.subtype === 'qemu' || v.subtype === 'lxc') return v.subtype;
  if (/vzdump-qemu-|backup\/vm\//.test(v.volid)) return 'qemu';
  if (/vzdump-lxc-|backup\/ct\//.test(v.volid)) return 'lxc';
  return undefined;
}

export async function getInventory(
  client: PveClient,
  conn: { id: string },
  nodeHint: string | undefined,
  topo: ClusterTopology | undefined,
): Promise<InventoryBundle> {
  const [version, resources, perms, nextId] = await Promise.all([
    client.version(),
    client.clusterResources(),
    client.accessPermissions().catch(() => undefined),
    client.nextId().catch(() => 100),
  ]);

  const rawNodes = resources.filter((r): r is RawNodeResource => r.type === 'node').sort((a, b) => a.node.localeCompare(b.node));
  const guests = resources.filter((r): r is RawGuestResource => r.type === 'qemu' || r.type === 'lxc');
  const node =
    rawNodes.find((n) => n.node === nodeHint)?.node ?? rawNodes.find((n) => n.status === 'online')?.node ?? rawNodes[0]?.node ?? '';

  const [rawStorages, network] = await Promise.all([client.nodeStorages(node).catch(() => []), client.nodeNetwork(node).catch(() => [])]);
  const storages = rawStorages
    .filter((s) => s.enabled !== 0)
    .map((s) => ({
      name: s.storage,
      type: s.type,
      content: (s.content ?? '').split(',').filter(Boolean),
      avail: s.avail ?? 0,
      total: s.total ?? 0,
      shared: s.shared === 1,
      active: s.active !== 0,
    }));
  const sharedByName = new Map(storages.map((s) => [s.name, s.shared]));

  // One content listing per (storage, content type) we care about.
  const wanted = ['iso', 'import', 'vztmpl', 'backup'];
  const queries = storages.filter((s) => s.active).flatMap((s) => s.content.filter((c) => wanted.includes(c)).map((c) => ({ storage: s.name, content: c })));
  const listings = await mapLimit(queries, 6, (q) => client.storageContent(node, q.storage, q.content).catch((): RawVolume[] => []));

  const byContent: Record<string, (RawVolume & { storage: string })[]> = { iso: [], import: [], vztmpl: [], backup: [] };
  queries.forEach((q, i) => {
    for (const v of listings[i] ?? []) if (v.content === q.content) byContent[q.content]!.push({ ...v, storage: q.storage });
  });

  const vol = (v: RawVolume & { storage: string }): InventoryVolume => ({
    volid: v.volid,
    storage: v.storage,
    name: fileName(v.volid),
    size: v.size ?? 0,
    shared: sharedByName.get(v.storage) ?? false,
  });
  const byName = (a: InventoryVolume, b: InventoryVolume) => a.name.localeCompare(b.name, undefined, { numeric: true });

  const isos = byContent.iso!.map(vol).sort(byName);
  const diskImages = byContent.import!.map(vol).filter((v) => isImportableDisk(v.name)).sort(byName);
  const lxcTemplates = byContent.vztmpl!.map(vol).sort(byName);

  // Backups: newest first; read the embedded config of the newest few to tell template backups apart.
  const backupsRaw = byContent.backup!.filter((v) => backupSubtype(v)).sort((a, b) => (b.ctime ?? 0) - (a.ctime ?? 0)).slice(0, MAX_BACKUPS);
  const templateFlags = await mapLimit(backupsRaw.slice(0, MAX_BACKUP_CONFIG_READS), 4, (v) =>
    client
      .backupConfig(node, v.volid)
      .then((cfg) => /^template:\s*1\s*$/m.test(typeof cfg === 'string' ? cfg : ''))
      .catch(() => undefined),
  );
  const backups: InventoryBackup[] = backupsRaw.map((v, i) => ({
    ...vol(v),
    subtype: backupSubtype(v)!,
    vmid: v.vmid,
    ctime: v.ctime,
    notes: v.notes?.trim() || undefined,
    template: templateFlags[i],
  }));

  const usedIps = new Set<string>();
  for (const n of topo?.nodes ?? []) {
    if (n.data.kind !== 'guest') continue;
    for (const nic of n.data.nets) if (nic.ip && nic.ip !== 'dhcp' && nic.ip !== 'manual') usedIps.add(nic.ip.split('/')[0]!);
  }

  const inv: TargetInventory = {
    conn: conn.id,
    node,
    version: version.version,
    mock: (version.repoid ?? '').startsWith('mock'),
    nodes: rawNodes.map((n) => ({ name: n.node, online: n.status === 'online', maxcpu: n.maxcpu ?? 0, maxmem: n.maxmem ?? 0, mem: n.mem ?? 0 })),
    // Importing disk images from "import" storage (download-url / import-from) arrived in Proxmox VE 8.3.
    features: { importImages: versionAtLeast(version.version, '8.3') },
    storages,
    bridges: network
      .filter((i) => i.type === 'bridge' || i.type === 'OVSBridge')
      .map((i) => ({ name: i.iface, cidr: i.cidr, gateway: i.gateway, vlanAware: i.bridge_vlan_aware === 1 }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    isos,
    diskImages,
    lxcTemplates,
    vmTemplates: guests
      .filter((g) => g.template === 1)
      .map((g) => ({ vmid: g.vmid, name: g.name ?? `${g.type}-${g.vmid}`, node: g.node, type: g.type, box: /(^|[;,])pf-box($|[;,])/.test(g.tags ?? '') }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    backups,
    virtioIso: [...isos].reverse().find((v) => looksLikeVirtioIso(v.name))?.volid,
    usedVmids: guests.map((g) => g.vmid),
    usedNames: guests.map((g) => g.name ?? '').filter(Boolean),
    usedIps: [...usedIps],
    nextId,
    permissions: perms ? summarizePermissions(perms) : unknownPermissions(),
  };
  return { inv, perms };
}
