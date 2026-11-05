import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
} from '@xyflow/react';
import { LoaderCircle, Plug, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePendingVmids, useTopology } from './api';
import type { CommonProps } from './components/AppChrome';
import { Inspector } from './components/Inspector';
import { TopBar } from './components/TopBar';
import { Z, layoutTopology, type FlowEdge, type FlowNode, type GuestFlowNode, type InspectableNode } from './layout';
import { nodeTypes } from './nodes';

const isGuestNode = (n: FlowNode): n is GuestFlowNode => n.data.kind === 'guest';
const isInspectable = (n: FlowNode): n is InspectableNode => n.data.kind !== 'band';

const EDGE_COLORS = { net: '#38bdf8', storage: '#f59e0b', hosts: '#52525b' } as const;
const MINIMAP_COLORS: Record<string, string> = { pveNode: '#27272a', band: '#1f1a12', guest: '#8b5cf6', bridge: '#0ea5e9', storage: '#f59e0b' };

/** A request from elsewhere (e.g. a finished deployment) to select and zoom to a node. */
export type FocusRequest = { id: string; n: number };

export function Canvas({ common, active, focus }: { common: CommonProps; active: boolean; focus?: FocusRequest | null }) {
  const [live, setLive] = useState(true);
  const [search, setSearch] = useState('');
  const [showNet, setShowNet] = useState(false);
  const [showStorage, setShowStorage] = useState(false);
  const [layoutKey, setLayoutKey] = useState(0);
  const [hoverId, setHoverId] = useState<string | null>(null);

  const topoQ = useTopology(live && active);
  const topo = topoQ.data;
  const connections = common.connections;
  const pendingVmids = usePendingVmids();

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges] = useEdgesState<FlowEdge>([]);
  const { fitView } = useReactFlow();
  const initialized = useNodesInitialized();
  const fitted = useRef(false);
  const appliedLayout = useRef(0);
  const clusterSignature = useRef('');

  // Merge each topology refresh into the canvas, keeping positions the user has dragged.
  useEffect(() => {
    if (!topo) return;
    const laid = layoutTopology(topo);
    // A connection appearing/disappearing changes the whole row structure → fresh layout.
    const signature = topo.clusters.map((c) => `${c.conn}:${c.ok ? 1 : 0}`).join('|');
    const structural = clusterSignature.current !== '' && clusterSignature.current !== signature;
    clusterSignature.current = signature;
    const reset = appliedLayout.current !== layoutKey || structural;
    appliedLayout.current = layoutKey;
    setNodes((prev) => {
      const prevById = new Map(prev.map((n) => [n.id, n]));
      return laid.nodes.map((n) => {
        const p = prevById.get(n.id);
        if (!p || reset) return n;
        return { ...n, position: p.position, selected: p.selected, measured: p.measured, dragging: p.dragging } as FlowNode;
      });
    });
    setEdges(laid.edges);
    if (reset && (layoutKey > 0 || structural)) window.setTimeout(() => fitView({ padding: 0.12, duration: 500 }), 60);
  }, [topo, layoutKey, setNodes, setEdges, fitView]);

  // First fit once React Flow has measured the nodes — and only while visible (a hidden canvas has no size).
  useEffect(() => {
    if (active && initialized && !fitted.current && nodes.length > 0) {
      fitted.current = true;
      window.requestAnimationFrame(() => fitView({ padding: 0.12, duration: 400 }));
    }
  }, [active, initialized, nodes.length, fitView]);

  const selectById = useCallback(
    (id: string) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id }) as FlowNode));
      if (id) fitView({ nodes: [{ id }], duration: 400, maxZoom: 1.1, padding: 0.5 });
    },
    [setNodes, fitView],
  );

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('[role="dialog"]')) selectById('');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectById, active]);

  // "Show on map" from a deployment: select the node once the topology contains it.
  const handledFocus = useRef(0);
  useEffect(() => {
    if (!active || !focus || handledFocus.current === focus.n) return;
    if (!nodes.some((n) => n.id === focus.id)) return; // not refreshed yet — try again on the next topology
    handledFocus.current = focus.n;
    selectById(focus.id);
  }, [active, focus, nodes, selectById]);

  const selected = useMemo(() => nodes.find((n) => n.selected && isInspectable(n)) as InspectableNode | undefined, [nodes]);

  // Edges are drawn for the selected node and the hovered node.
  const focusIds = useMemo(() => {
    const s = new Set<string>();
    if (selected) s.add(selected.id);
    if (hoverId) s.add(hoverId);
    return s;
  }, [selected, hoverId]);

  const hoverNode = useMemo(() => (hoverId ? nodes.find((n) => n.id === hoverId) : undefined), [nodes, hoverId]);
  const focusGuestIds = useMemo(() => {
    const s = new Set<string>();
    if (selected?.data.kind === 'guest') s.add(selected.id);
    if (hoverNode?.data.kind === 'guest') s.add(hoverNode.id);
    return s;
  }, [selected, hoverNode]);

  // Nodes one edge away from a focused node, tagged with the relation kind (drives the coloured glow).
  const relatedKinds = useMemo(() => {
    const m = new Map<string, 'net' | 'storage'>();
    if (!focusIds.size) return m;
    for (const e of edges) {
      const kind = e.data?.kind;
      if (kind !== 'net' && kind !== 'storage') continue;
      if (focusIds.has(e.source)) m.set(e.target, kind);
      else if (focusIds.has(e.target)) m.set(e.source, kind);
    }
    return m;
  }, [edges, focusIds]);

  const neighborIds = useMemo(() => {
    const s = new Set<string>();
    if (!selected) return s;
    for (const e of edges) {
      if (e.source === selected.id) s.add(e.target);
      if (e.target === selected.id) s.add(e.source);
    }
    if (selected.parentId) s.add(selected.parentId);
    for (const n of nodes) if (n.parentId === selected.id) s.add(n.id);
    return s;
  }, [selected, edges, nodes]);

  const q = search.trim().toLowerCase();
  const matchesSearch = useCallback(
    (n: FlowNode) => {
      if (!q) return true;
      const d = n.data;
      if (d.kind === 'guest') {
        return (
          d.name.toLowerCase().includes(q) ||
          String(d.vmid).includes(q) ||
          d.node.toLowerCase().includes(q) ||
          d.tags.some((t) => t.toLowerCase().includes(q))
        );
      }
      return d.name.toLowerCase().includes(q);
    },
    [q],
  );

  const viewNodes = useMemo(
    () =>
      nodes.map((n) => {
        const container = n.data.kind === 'node' || n.data.kind === 'band';
        const classes: string[] = [];
        if (q && !container && !matchesSearch(n)) classes.push('dimmed');
        if (selected && n.id !== selected.id && n.data.kind !== 'band') classes.push(neighborIds.has(n.id) ? 'related' : 'unrelated');
        const rel = relatedKinds.get(n.id);
        if (rel && !focusIds.has(n.id)) classes.push(`rel-${rel}`);
        let out: FlowNode = n;
        if (isGuestNode(n) && pendingVmids.has(n.data.vmid)) out = { ...n, data: { ...n.data, pending: true } };
        return classes.length ? ({ ...out, className: classes.join(' ') } as FlowNode) : out;
      }),
    [nodes, q, matchesSearch, selected, neighborIds, relatedKinds, focusIds, pendingVmids],
  );

  const viewEdges = useMemo(
    () =>
      edges.flatMap((e): FlowEdge[] => {
        const kind = e.data?.kind ?? 'hosts';
        const focused = focusIds.has(e.source) || focusIds.has(e.target);
        const forced = kind === 'net' ? showNet : kind === 'storage' ? showStorage : false;
        if (!focused && !forced) return [];
        if (focused) {
          const color = EDGE_COLORS[kind];
          const isSelectedEdge = !!selected && (e.source === selected.id || e.target === selected.id);
          // Labels only when a single guest is in focus — a hovered bridge with 7 edges would be a wall of text.
          const showLabel = focusGuestIds.has(e.source) || focusGuestIds.has(e.target);
          return [
            {
              ...e,
              animated: isSelectedEdge,
              zIndex: Z.focusEdge,
              style: { stroke: color, strokeWidth: isSelectedEdge ? 2.2 : 1.6, opacity: 1 },
              label: showLabel ? e.data?.label : undefined,
              labelStyle: { fill: color, fontSize: 10, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
              labelBgStyle: { fill: '#09090b', fillOpacity: 0.92 },
              labelBgPadding: [6, 3] as [number, number],
              labelBgBorderRadius: 4,
            },
          ];
        }
        // Forced-on edges are ghosted and sit beneath the cards.
        return [
          {
            ...e,
            animated: false,
            zIndex: Z.ghostEdge,
            style: { stroke: EDGE_COLORS[kind], strokeWidth: 1.4, opacity: selected ? 0.12 : 0.45 },
          },
        ];
      }),
    [edges, focusIds, focusGuestIds, selected, showNet, showStorage],
  );

  const counts = useMemo(() => {
    let guests = 0;
    let running = 0;
    for (const n of topo?.nodes ?? []) {
      if (n.data.kind === 'guest' && !n.data.template) {
        guests++;
        if (n.data.status === 'running') running++;
      }
    }
    const nodeCount = (topo?.clusters ?? []).reduce((acc, c) => acc + (c.ok ? c.nodeCount : 0), 0);
    return { nodes: nodeCount, guests, running };
  }, [topo]);

  const noConnections = common.connectionsLoaded && connections.length === 0;
  const nothingToShow = !noConnections && topo !== undefined && topo.clusters.length === 0;

  return (
    <div className="flex h-full w-full flex-col">
      <TopBar
        common={common}
        clusters={topo?.clusters ?? []}
        counts={counts}
        fetchedAt={topo?.fetchedAt}
        isFetching={topoQ.isFetching}
        search={search}
        onSearch={setSearch}
        live={live}
        onLive={setLive}
        showNet={showNet}
        onShowNet={setShowNet}
        showStorage={showStorage}
        onShowStorage={setShowStorage}
        onRelayout={() => setLayoutKey((k) => k + 1)}
        onFit={() => fitView({ padding: 0.12, duration: 400 })}
      />

      <div className="relative min-h-0 flex-1">
        <ReactFlow<FlowNode, FlowEdge>
          nodes={viewNodes}
          edges={viewEdges}
          onNodesChange={onNodesChange}
          onNodeMouseEnter={(_, n) => setHoverId(n.id)}
          onNodeMouseLeave={() => setHoverId(null)}
          nodeTypes={nodeTypes}
          colorMode="dark"
          zIndexMode="manual"
          nodesConnectable={false}
          selectNodesOnDrag={false}
          deleteKeyCode={null}
          minZoom={0.1}
          maxZoom={2.5}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="#27272a" />
          <Controls showInteractive={false} position="top-left" />
          <MiniMap
            pannable
            zoomable
            position="bottom-left"
            nodeColor={(n) => MINIMAP_COLORS[n.type ?? ''] ?? '#52525b'}
            nodeStrokeWidth={0}
            maskColor="rgba(9, 9, 11, 0.75)"
            bgColor="#18181b"
            style={{ width: 160, height: 110 }}
          />
        </ReactFlow>

        {selected && topo && <Inspector node={selected} topo={topo} onClose={() => selectById('')} onSelect={selectById} />}

        {!topo && topoQ.isPending && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-zinc-400">
            <LoaderCircle className="h-4 w-4 animate-spin" /> Loading topology…
          </div>
        )}

        {(noConnections || nothingToShow) && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950/90 p-6 text-center shadow-2xl backdrop-blur">
              <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500/10 text-sky-300">
                <Plug className="h-5 w-5" />
              </div>
              <h2 className="text-sm font-semibold text-zinc-100">{noConnections ? 'No Proxmox hosts connected yet' : 'All connections are disabled'}</h2>
              <p className="mt-1 text-xs text-zinc-500">
                {noConnections ? 'Add a host or cluster and ProxFlow will draw it here — nodes, guests, bridges and storage.' : 'Enable a connection to see its map.'}
              </p>
              <button
                type="button"
                onClick={common.onOpenConnections}
                className="mt-4 inline-flex h-9 items-center gap-2 rounded-lg border border-sky-500/50 bg-sky-500/15 px-4 text-xs font-semibold text-sky-100 hover:bg-sky-500/25"
              >
                <Plug className="h-3.5 w-3.5" /> {noConnections ? 'Connect to Proxmox' : 'Manage connections'}
              </button>
            </div>
          </div>
        )}

        {topoQ.isError && (
          <div className="absolute left-1/2 top-4 z-30 flex max-w-[640px] -translate-x-1/2 items-start gap-2 rounded-xl border border-rose-500/40 bg-rose-950/80 px-4 py-3 text-xs text-rose-100 shadow-xl backdrop-blur">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" />
            <div>
              <div className="font-semibold">Can't load topology</div>
              <div className="mt-0.5 text-rose-200/80">{topoQ.error.message}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
