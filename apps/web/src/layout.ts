/**
 * Deterministic layout. Each connection (cluster or standalone host) is a row:
 *   ┌ cluster strip ─────────────────────────────────┐
 *   ┌ pve1 group ───────┐  ┌ pve2 group ───────┐
 *   │ guests grid       │  │ guests grid       │
 *   │ bridges · storage │  │ bridges · storage │
 *   └───────────────────┘  └───────────────────┘
 *            ┌ shared storage band ┐
 * Unreachable connections become a single error strip.
 *
 * z-order (ReactFlow runs in zIndexMode="manual"):
 *   0 group boxes / bands · 1 ghosted edges · 2 cards & pills · 3 focused edges
 */
import type { Edge, Node } from '@xyflow/react';
import type { BridgeData, EdgeKind, GuestData, PveNodeData, StorageData, Topology } from '@proxflow/shared';

export type BandTone = 'cluster' | 'shared' | 'error';
export type BandData = { kind: 'band'; name: string; subtitle?: string; tone: BandTone };

export type PveFlowNode = Node<PveNodeData, 'pveNode'>;
export type GuestFlowNode = Node<GuestData & { pending?: boolean }, 'guest'>;
export type BridgeFlowNode = Node<BridgeData, 'bridge'>;
export type StorageFlowNode = Node<StorageData, 'storage'>;
export type BandFlowNode = Node<BandData, 'band'>;
export type FlowNode = PveFlowNode | GuestFlowNode | BridgeFlowNode | StorageFlowNode | BandFlowNode;
/** Nodes the inspector can show (everything except decorative bands). */
export type InspectableNode = Exclude<FlowNode, BandFlowNode>;
export type FlowEdge = Edge<{ kind: EdgeKind; label?: string }>;

export const Z = { container: 0, ghostEdge: 1, item: 2, focusEdge: 3 } as const;

export const SIZES = {
  guest: { w: 236, h: 132 },
  pill: { h: 64, minW: 164, maxCols: 4 },
  sharedPillW: 236,
  header: 56,
  bandHeader: 40,
  strip: { h: 44, w: 760 },
  stripGap: 20,
  pad: 20,
  gap: 14,
  sectionGap: 40,
  groupGap: 90,
  cols: 3,
  minInner: 520,
  sharedGap: 90,
  clusterGap: 140,
} as const;

type Entry<D> = { id: string; data: D };

export function layoutTopology(topo: Topology): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const S = SIZES;
  const pvesByConn = new Map<string, Entry<PveNodeData>[]>();
  const guestsByNode = new Map<string, Entry<GuestData>[]>(); // key: conn/node
  const bridgesByNode = new Map<string, Entry<BridgeData>[]>();
  const localByNode = new Map<string, Entry<StorageData>[]>();
  const sharedByConn = new Map<string, Entry<StorageData>[]>();

  const push = <D>(map: Map<string, Entry<D>[]>, key: string, e: Entry<D>) => map.set(key, [...(map.get(key) ?? []), e]);
  const nodeKey = (conn: string, node: string) => `${conn}/${node}`;

  for (const n of topo.nodes) {
    const d = n.data;
    switch (d.kind) {
      case 'node':
        push(pvesByConn, d.conn, { id: n.id, data: d });
        break;
      case 'guest':
        push(guestsByNode, nodeKey(d.conn, d.node), { id: n.id, data: d });
        break;
      case 'bridge':
        push(bridgesByNode, nodeKey(d.conn, d.node), { id: n.id, data: d });
        break;
      case 'storage':
        if (d.shared) push(sharedByConn, d.conn, { id: n.id, data: d });
        else push(localByNode, nodeKey(d.conn, d.nodes[0] ?? ''), { id: n.id, data: d });
        break;
    }
  }

  const nodes: FlowNode[] = [];
  const placedNodes = new Set<string>();
  let y = 0;

  for (const cluster of topo.clusters) {
    if (!cluster.ok) {
      nodes.push({
        id: `band:${cluster.conn}:error`,
        type: 'band',
        position: { x: 0, y },
        data: { kind: 'band', tone: 'error', name: `${cluster.connName} — can't connect`, subtitle: cluster.error },
        style: { width: S.strip.w, height: S.strip.h + 12 },
        zIndex: Z.container,
        selectable: false,
      });
      y += S.strip.h + 12 + S.clusterGap;
      continue;
    }

    const pves = (pvesByConn.get(cluster.conn) ?? []).sort((a, b) => a.data.name.localeCompare(b.data.name, undefined, { numeric: true }));
    const rowTop = y + S.strip.h + S.stripGap;
    let x = 0;
    let rowMaxH = 0;

    for (const pve of pves) {
      const key = nodeKey(cluster.conn, pve.data.name);
      placedNodes.add(key);
      const guests = (guestsByNode.get(key) ?? []).sort(
        (a, b) => Number(a.data.template) - Number(b.data.template) || a.data.vmid - b.data.vmid,
      );
      const pills: (Entry<BridgeData> | Entry<StorageData>)[] = [
        ...(bridgesByNode.get(key) ?? []).sort((a, b) => a.data.name.localeCompare(b.data.name, undefined, { numeric: true })),
        ...(localByNode.get(key) ?? []).sort((a, b) => a.data.name.localeCompare(b.data.name)),
      ];

      const cols = Math.max(1, Math.min(S.cols, guests.length));
      const guestRows = Math.ceil(guests.length / cols);
      const guestsW = guests.length ? cols * S.guest.w + (cols - 1) * S.gap : 0;
      const innerW = Math.max(S.minInner, guestsW);

      // Pills stretch to fill the row (up to maxCols per row, never narrower than minW).
      const fitCols = Math.max(1, Math.floor((innerW + S.gap) / (S.pill.minW + S.gap)));
      const pillCols = Math.max(1, Math.min(pills.length, fitCols, S.pill.maxCols));
      const pillW = Math.floor((innerW - (pillCols - 1) * S.gap) / pillCols);
      const pillRows = Math.ceil(pills.length / pillCols);

      const guestsH = guestRows ? guestRows * S.guest.h + (guestRows - 1) * S.gap : 0;
      const pillsH = pillRows ? pillRows * S.pill.h + (pillRows - 1) * S.gap : 0;
      const height = S.header + S.pad + guestsH + (guestsH && pillsH ? S.sectionGap : 0) + pillsH + S.pad;
      const width = innerW + 2 * S.pad;

      nodes.push({
        id: pve.id,
        type: 'pveNode',
        position: { x, y: rowTop },
        data: pve.data,
        style: { width, height },
        zIndex: Z.container,
      });

      guests.forEach((g, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        nodes.push({
          id: g.id,
          type: 'guest',
          parentId: pve.id,
          extent: 'parent',
          position: { x: S.pad + col * (S.guest.w + S.gap), y: S.header + S.pad + row * (S.guest.h + S.gap) },
          data: g.data,
          style: { width: S.guest.w, height: S.guest.h },
          zIndex: Z.item,
        });
      });

      const pillY = S.header + S.pad + guestsH + (guestsH ? S.sectionGap : 0);
      pills.forEach((p, i) => {
        const col = i % pillCols;
        const row = Math.floor(i / pillCols);
        const common = {
          id: p.id,
          parentId: pve.id,
          extent: 'parent' as const,
          position: { x: S.pad + col * (pillW + S.gap), y: pillY + row * (S.pill.h + S.gap) },
          style: { width: pillW, height: S.pill.h },
          zIndex: Z.item,
        };
        if (p.data.kind === 'bridge') nodes.push({ ...common, type: 'bridge', data: p.data });
        else nodes.push({ ...common, type: 'storage', data: p.data });
      });

      x += width + S.groupGap;
      rowMaxH = Math.max(rowMaxH, height);
    }

    const rowW = Math.max(x - S.groupGap, S.strip.w);

    // Cluster strip above the row.
    const nodeWord = cluster.nodeCount === 1 ? 'node' : 'nodes';
    nodes.push({
      id: `band:${cluster.conn}:cluster`,
      type: 'band',
      position: { x: 0, y },
      data: {
        kind: 'band',
        tone: 'cluster',
        name: cluster.name,
        subtitle: [
          cluster.connName !== cluster.name ? cluster.connName : undefined,
          `Proxmox VE ${cluster.version ?? '?'}`,
          `${cluster.nodeCount} ${nodeWord}`,
          cluster.mock ? 'mock' : undefined,
          !cluster.quorate ? 'NO QUORUM' : undefined,
          pves.length === 0 ? 'nothing visible — check this connection\'s permissions' : undefined,
        ]
          .filter(Boolean)
          .join(' · '),
      },
      style: { width: rowW, height: S.strip.h },
      zIndex: Z.container,
      selectable: false,
    });

    let bottom = rowTop + rowMaxH;

    // Shared storage band, centred under the groups.
    const shared = (sharedByConn.get(cluster.conn) ?? []).sort((a, b) => a.data.name.localeCompare(b.data.name));
    if (shared.length) {
      const bandId = `band:${cluster.conn}:shared`;
      const perRow = Math.max(1, Math.min(shared.length, Math.floor((rowW - 2 * S.pad + S.gap) / (S.sharedPillW + S.gap))));
      const rows = Math.ceil(shared.length / perRow);
      const innerW = perRow * S.sharedPillW + (perRow - 1) * S.gap;
      const width = innerW + 2 * S.pad;
      const height = S.bandHeader + S.pad + rows * S.pill.h + (rows - 1) * S.gap + S.pad;
      const by = bottom + S.sharedGap;
      nodes.push({
        id: bandId,
        type: 'band',
        position: { x: (rowW - width) / 2, y: by },
        data: { kind: 'band', tone: 'shared', name: 'Shared storage', subtitle: 'reachable from every node' },
        style: { width, height },
        zIndex: Z.container,
        selectable: false,
      });
      shared.forEach((s, i) => {
        const col = i % perRow;
        const row = Math.floor(i / perRow);
        nodes.push({
          id: s.id,
          type: 'storage',
          parentId: bandId,
          extent: 'parent',
          position: { x: S.pad + col * (S.sharedPillW + S.gap), y: S.bandHeader + S.pad + row * (S.pill.h + S.gap) },
          data: s.data,
          style: { width: S.sharedPillW, height: S.pill.h },
          zIndex: Z.item,
        });
      });
      bottom = by + height;
    }

    y = bottom + S.clusterGap;
  }

  // Guests whose node isn't in the resource list (shouldn't happen, but never lose data).
  const orphans = [...guestsByNode.entries()].filter(([key]) => !placedNodes.has(key)).flatMap(([, gs]) => gs);
  orphans.forEach((g, i) => {
    nodes.push({
      id: g.id,
      type: 'guest',
      position: { x: i * (S.guest.w + S.gap), y },
      data: g.data,
      style: { width: S.guest.w, height: S.guest.h },
      zIndex: Z.item,
    });
  });

  const edges: FlowEdge[] = topo.edges
    .filter((e) => e.kind !== 'hosts') // containment already shows this
    .map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'default',
      data: { kind: e.kind, label: e.label },
    }));

  return { nodes, edges };
}
