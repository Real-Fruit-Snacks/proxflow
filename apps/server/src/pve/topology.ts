/**
 * Turns raw Proxmox API data from one connection into a slice of the topology graph:
 *   node ──hosts──▶ guest ──net──▶ bridge
 *                          └──storage──▶ storage
 */
import {
  ids,
  type BridgeData,
  type ClusterInfo,
  type GuestStatus,
  type NodeStatus,
  type TopoEdge,
  type TopoNode,
} from '@proxflow/shared';
import { PveError, type PveClient } from './client.js';
import { parseDisks, parseNets } from './parse.js';
import type { RawGuestConfig, RawGuestResource, RawNetwork, RawNodeResource, RawResource, RawStorageResource } from './types.js';

export type ConnRef = { id: string; name: string };
export type ClusterTopology = { cluster: ClusterInfo; nodes: TopoNode[]; edges: TopoEdge[] };

const isNode = (r: RawResource): r is RawNodeResource => r.type === 'node';
const isGuest = (r: RawResource): r is RawGuestResource => r.type === 'qemu' || r.type === 'lxc';
const isStorage = (r: RawResource): r is RawStorageResource => r.type === 'storage';

const nodeStatus = (s?: string): NodeStatus => (s === 'online' ? 'online' : s === 'offline' ? 'offline' : 'unknown');
const guestStatus = (s?: string): GuestStatus =>
  s === 'running' || s === 'stopped' || s === 'paused' || s === 'suspended' ? s : 'unknown';

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function buildTopology(client: PveClient, conn: ConnRef): Promise<ClusterTopology> {
  const c = conn.id;
  const [version, status, resources] = await Promise.all([
    client.version(),
    // /cluster/status needs Sys.Audit on "/", which VM-admin roles don't have; the map works without it.
    client.clusterStatus().catch(() => []),
    client.clusterResources(),
  ]);

  const rawNodes = resources.filter(isNode).sort((a, b) => a.node.localeCompare(b.node));
  const rawGuests = resources.filter(isGuest).sort((a, b) => a.vmid - b.vmid);
  const rawStorages = resources.filter(isStorage);

  const clusterEntry = status.find((s) => s.type === 'cluster');
  const nodeEntries = status.filter((s) => s.type === 'node');
  const cluster: ClusterInfo = {
    conn: c,
    connName: conn.name,
    name: clusterEntry?.name ?? nodeEntries[0]?.name ?? (rawNodes.length === 1 ? rawNodes[0]!.node : conn.name),
    quorate: clusterEntry ? clusterEntry.quorate === 1 : true, // standalone node: always "quorate"
    nodeCount: clusterEntry?.nodes ?? (nodeEntries.length || rawNodes.length),
    version: version.version,
    mock: (version.repoid ?? '').startsWith('mock'),
    ok: true,
  };

  // Per-node network + per-guest config are the only non-cluster-wide calls.
  const offline = new Set(rawNodes.filter((n) => n.status !== 'online').map((n) => n.node));
  const [networks, configs] = await Promise.all([
    mapLimit(rawNodes, 4, async (n): Promise<RawNetwork[]> =>
      n.status === 'online' ? client.nodeNetwork(n.node).catch(() => []) : [],
    ),
    // Configs of guests on an offline node would each wait for a timeout (Proxmox proxies them to that node).
    mapLimit(rawGuests, 8, (g) =>
      offline.has(g.node) ? Promise.resolve<RawGuestConfig>({}) : client.guestConfig(g.node, g.type, g.vmid).catch((): RawGuestConfig => ({})),
    ),
  ]);

  const nodes: TopoNode[] = [];
  const edges: TopoEdge[] = [];

  for (const n of rawNodes) {
    nodes.push({
      id: ids.node(c, n.node),
      data: {
        kind: 'node',
        conn: c,
        name: n.node,
        status: nodeStatus(n.status),
        cpu: n.cpu ?? 0,
        maxcpu: n.maxcpu ?? 0,
        mem: n.mem ?? 0,
        maxmem: n.maxmem ?? 0,
        disk: n.disk ?? 0,
        maxdisk: n.maxdisk ?? 0,
        uptime: n.uptime ?? 0,
      },
    });
  }

  const bridgeIds = new Set<string>();
  rawNodes.forEach((n, i) => {
    for (const iface of networks[i] ?? []) {
      if (iface.type !== 'bridge' && iface.type !== 'OVSBridge') continue;
      const id = ids.bridge(c, n.node, iface.iface);
      bridgeIds.add(id);
      const data: BridgeData = {
        kind: 'bridge',
        conn: c,
        name: iface.iface,
        node: n.node,
        cidr: iface.cidr,
        address: iface.address,
        gateway: iface.gateway,
        ports: (iface.bridge_ports ?? iface.ovs_ports ?? '')
          .split(/\s+/)
          .filter((p) => p && p !== 'none'),
        active: iface.active === 1,
        vlanAware: iface.bridge_vlan_aware === 1,
      };
      nodes.push({ id, data });
    }
  });

  // Storage: shared storages collapse into one node; local ones are per-node.
  const byName = new Map<string, RawStorageResource[]>();
  for (const s of rawStorages) byName.set(s.storage, [...(byName.get(s.storage) ?? []), s]);
  const sharedNames = new Set<string>();
  const storageIds = new Set<string>();
  for (const [name, entries] of byName) {
    const shared = entries.some((e) => e.shared === 1);
    const first = entries[0]!;
    const content = (first.content ?? '').split(',').filter(Boolean);
    if (shared) {
      sharedNames.add(name);
      const id = ids.sharedStorage(c, name);
      storageIds.add(id);
      nodes.push({
        id,
        data: {
          kind: 'storage',
          conn: c,
          name,
          type: first.plugintype ?? 'unknown',
          nodes: entries.map((e) => e.node).sort(),
          shared: true,
          content,
          used: first.disk ?? 0,
          total: first.maxdisk ?? 0,
          active: entries.some((e) => e.status === 'available'),
        },
      });
    } else {
      for (const e of entries) {
        const id = ids.localStorage(c, e.node, name);
        storageIds.add(id);
        nodes.push({
          id,
          data: {
            kind: 'storage',
            conn: c,
            name,
            type: e.plugintype ?? 'unknown',
            nodes: [e.node],
            shared: false,
            content,
            used: e.disk ?? 0,
            total: e.maxdisk ?? 0,
            active: e.status === 'available',
          },
        });
      }
    }
  }

  rawGuests.forEach((g, i) => {
    const cfg = configs[i] ?? {};
    const nets = parseNets(g.type, cfg);
    const disks = parseDisks(g.type, cfg);
    const id = ids.guest(c, g.vmid);
    nodes.push({
      id,
      data: {
        kind: 'guest',
        conn: c,
        type: g.type,
        vmid: g.vmid,
        name: g.name ?? `${g.type}-${g.vmid}`,
        node: g.node,
        status: guestStatus(g.status),
        template: g.template === 1,
        cpu: g.cpu ?? 0,
        maxcpu: g.maxcpu ?? 0,
        mem: g.mem ?? 0,
        maxmem: g.maxmem ?? 0,
        maxdisk: g.maxdisk ?? 0,
        uptime: g.uptime ?? 0,
        tags: (g.tags ?? '').split(/[;,]/).map((t) => t.trim()).filter(Boolean),
        ostype: typeof cfg.ostype === 'string' ? cfg.ostype : undefined,
        nets,
        disks,
      },
    });

    edges.push({ id: `${c}/hosts:${g.node}:${g.vmid}`, source: ids.node(c, g.node), target: id, kind: 'hosts' });

    for (const n of nets) {
      if (!n.bridge) continue;
      const bid = ids.bridge(c, g.node, n.bridge);
      if (!bridgeIds.has(bid)) continue;
      edges.push({
        id: `${c}/net:${g.vmid}:${n.key}`,
        source: id,
        target: bid,
        kind: 'net',
        label: n.vlan ? `${n.key} · VLAN ${n.vlan}` : n.key,
      });
    }

    const perStorage = new Map<string, string[]>();
    for (const d of disks) {
      const sid = sharedNames.has(d.storage) ? ids.sharedStorage(c, d.storage) : ids.localStorage(c, g.node, d.storage);
      if (!storageIds.has(sid)) continue;
      perStorage.set(sid, [...(perStorage.get(sid) ?? []), d.key]);
    }
    for (const [sid, keys] of perStorage) {
      edges.push({ id: `${c}/sto:${g.vmid}:${sid}`, source: id, target: sid, kind: 'storage', label: keys.join(', ') });
    }
  });

  return { cluster, nodes, edges };
}

/** How long a refresh that fails with a network or server error may fall back to the last good topology. */
const STALE_OK_MS = 20_000;

export interface TopologyService {
  get(): Promise<ClusterTopology>;
  invalidate(): void;
}

/** Memoises buildTopology for `cacheMs` and coalesces concurrent calls. */
export function createTopologyService(client: PveClient, conn: ConnRef, cacheMs: number): TopologyService {
  let cached: { at: number; value: ClusterTopology } | null = null;
  let lastGood: { at: number; value: ClusterTopology } | null = null;
  let inflight: Promise<ClusterTopology> | null = null;
  let generation = 0; // bumped by invalidate(), so a fetch that started before an action can't be reused or cached
  return {
    get() {
      if (cached && Date.now() - cached.at < cacheMs) return Promise.resolve(cached.value);
      if (inflight) return inflight;
      const gen = generation;
      const p: Promise<ClusterTopology> = buildTopology(client, conn)
        .then((value) => {
          lastGood = { at: Date.now(), value };
          if (gen === generation) cached = lastGood;
          return value;
        })
        .catch((err: unknown) => {
          // One missed answer (a busy node, a dropped packet) shouldn't flash the whole cluster red and
          // reset the map's layout: show the last good picture for a little while before reporting it.
          const blip = err instanceof PveError && (err.isNetwork || err.status >= 500);
          if (blip && lastGood && Date.now() - lastGood.at < STALE_OK_MS) return lastGood.value;
          throw err;
        })
        .finally(() => {
          if (inflight === p) inflight = null;
        });
      inflight = p;
      return p;
    },
    invalidate() {
      cached = null;
      inflight = null;
      generation++;
    },
  };
}
