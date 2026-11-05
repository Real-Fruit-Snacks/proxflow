import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection as FlowConnection,
  type Edge,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import clsx from 'clsx';
import { Hammer, Rocket } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { validateLab } from '@proxflow/shared';
import { Brand, ConnectionButton, ModeSwitch, type CommonProps } from '../components/AppChrome';
import { ActionButton } from '../components/ConfirmButton';
import { ApiError, useDeployment, useInventory } from './api';
import { BLUEPRINT_SIZE, BlueprintNode, type BlueprintFlowNode } from './BlueprintNode';
import { DeployDialog } from './DeployDialog';
import { DeploymentPanel } from './DeploymentPanel';
import { applyPreset, fillTarget, firstOkConnection, loadDesign, newMachine, saveDesign, toSpec, type LabDesign, type PaletteKind, type Preset } from './design';
import { LabPanel } from './LabPanel';
import { describeSource } from './labels';
import { MachinePanel } from './MachinePanel';
import { DRAG_TYPE, Palette } from './Palette';

const nodeTypes = { blueprint: BlueprintNode };
type Props = { common: CommonProps; active: boolean; onShowOnMap: (id: string) => void };

function useDesign() {
  const [design, setDesign] = useState<LabDesign>(loadDesign);
  useEffect(() => {
    const t = setTimeout(() => saveDesign(design), 250);
    return () => clearTimeout(t);
  }, [design]);
  return [design, setDesign] as const;
}

const canJoin = (m: LabDesign['machines'][number] | undefined) => m?.kind === 'linux-vm' || (m?.kind === 'windows' && m.role === 'server');
const isDc = (m: LabDesign['machines'][number] | undefined) => m?.kind === 'windows' && m.role === 'dc';

export function BuildView({ common, active, onShowOnMap }: Props) {
  const [design, setDesign] = useDesign();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [deployOpen, setDeployOpen] = useState(false);
  const { screenToFlowPosition, fitView } = useReactFlow();
  const wrapper = useRef<HTMLDivElement>(null);

  // ───── target & inventory ─────
  const conns = common.connections;
  useEffect(() => {
    if (!common.connectionsLoaded) return;
    if (!design.target.conn || !conns.some((c) => c.id === design.target.conn)) {
      const c = firstOkConnection(conns);
      if (c && c.id !== design.target.conn) setDesign((d) => ({ ...d, target: { conn: c.id } }));
    }
  }, [common.connectionsLoaded, conns, design.target.conn, setDesign]);

  const invQ = useInventory(design.target.conn, design.target.node);
  const inv = invQ.data;
  useEffect(() => {
    if (!inv) return;
    setDesign((d) => {
      const t = fillTarget(d.target, inv);
      return JSON.stringify(t) === JSON.stringify(d.target) ? d : { ...d, target: t };
    });
  }, [inv, setDesign]);

  // ───── validation & deployment ─────
  const spec = useMemo(() => toSpec(design), [design]);
  const issues = useMemo(() => validateLab(spec, inv), [spec, inv]);
  const errorCount = issues.filter((i) => i.level === 'error').length;
  const depQ = useDeployment(design.activeDeployment);
  const dep = depQ.data;
  const deploying = dep?.status === 'running' || dep?.status === 'destroying';
  useEffect(() => {
    // The deployment was pruned on the server (or never existed): forget it. Any other error (ProxFlow
    // restarting, the laptop waking up) is temporary — keep it, or the lab could no longer be destroyed.
    const gone = depQ.error instanceof ApiError && depQ.error.status === 404;
    if (gone && design.activeDeployment) setDesign((d) => ({ ...d, activeDeployment: undefined }));
  }, [depQ.error, design.activeDeployment, setDesign]);

  // ───── canvas state (React Flow owns measurement/selection; the design owns everything else) ─────
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<BlueprintFlowNode>([]);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<Edge>([]);

  useEffect(() => {
    const hasDc = design.machines.some(isDc);
    setNodes((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      return design.machines.map((m) => {
        const p = byId.get(m.id);
        const dc = m.kind === 'windows' && m.role === 'dc' ? m : design.machines.find((x) => x.id === ('joinDomainOf' in m ? m.joinDomainOf : undefined));
        const mine = issues.filter((i) => i.machine === m.id);
        return {
          id: m.id,
          type: 'blueprint' as const,
          position: p?.dragging ? p.position : m.position,
          selected: m.id === selectedId,
          measured: p?.measured,
          style: { width: BLUEPRINT_SIZE.w, height: BLUEPRINT_SIZE.h },
          data: {
            machine: m,
            source: describeSource(m, inv),
            errors: mine.filter((i) => i.level === 'error').length,
            warnings: mine.filter((i) => i.level === 'warning').length,
            domain: dc?.kind === 'windows' ? dc.domain?.fqdn : undefined,
            hasDc,
            run: dep?.machines.find((x) => x.id === m.id && dep.status !== 'destroyed'),
          },
        };
      });
    });
    setEdges(
      design.machines.flatMap((m) => {
        const target = 'joinDomainOf' in m ? m.joinDomainOf : undefined;
        const dc = design.machines.find((x) => x.id === target);
        if (!target || dc?.kind !== 'windows') return [];
        return [
          {
            id: `join:${m.id}`,
            source: m.id,
            sourceHandle: 'join',
            target,
            targetHandle: 'domain',
            animated: true, // no label: the member card already says "joins <domain>"
            style: { stroke: '#8b5cf6', strokeWidth: 1.8 },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#8b5cf6' },
          },
        ];
      }),
    );
  }, [design.machines, issues, inv, dep, selectedId, setNodes, setEdges]);

  const removeMachines = useCallback(
    (ids: string[]) =>
      setDesign((d) => ({
        ...d,
        machines: d.machines
          .filter((m) => !ids.includes(m.id))
          .map((m) => ('joinDomainOf' in m && m.joinDomainOf && ids.includes(m.joinDomainOf) ? { ...m, joinDomainOf: undefined } : m)),
      })),
    [setDesign],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<BlueprintFlowNode>[]) => {
      onNodesChangeBase(changes);
      const moved = new Map<string, { x: number; y: number }>();
      const removed: string[] = [];
      // React Flow holds the live position while dragging; the design only learns it when the drag ends
      // (the drag-end change carries the final position — see @xyflow/react updateNodePositions).
      for (const c of changes) {
        if (c.type === 'position' && c.dragging === false && c.position) moved.set(c.id, c.position);
        if (c.type === 'remove') removed.push(c.id);
        if (c.type === 'select') setSelectedId((s) => (c.selected ? c.id : s === c.id ? null : s));
      }
      if (moved.size) {
        setDesign((d) => ({ ...d, machines: d.machines.map((m) => (moved.has(m.id) ? { ...m, position: moved.get(m.id)! } : m)) }));
      }
      if (removed.length) {
        removeMachines(removed);
        setSelectedId((s) => (s && removed.includes(s) ? null : s));
      }
    },
    [onNodesChangeBase, setDesign, removeMachines],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChangeBase(changes);
      const unlink = changes.flatMap((c) => (c.type === 'remove' && c.id.startsWith('join:') ? [c.id.slice(5)] : []));
      if (unlink.length) setDesign((d) => ({ ...d, machines: d.machines.map((m) => (unlink.includes(m.id) && 'joinDomainOf' in m ? { ...m, joinDomainOf: undefined } : m)) }));
    },
    [onEdgesChangeBase, setDesign],
  );

  const isValidConnection = useCallback(
    (c: FlowConnection | Edge) => {
      const src = design.machines.find((m) => m.id === c.source);
      const tgt = design.machines.find((m) => m.id === c.target);
      return c.source !== c.target && canJoin(src) && isDc(tgt);
    },
    [design.machines],
  );

  const onConnect = useCallback(
    (c: FlowConnection) => {
      if (!isValidConnection(c)) return;
      setDesign((d) => ({ ...d, machines: d.machines.map((m) => (m.id === c.source && 'joinDomainOf' in m ? { ...m, joinDomainOf: c.target } : m)) }));
    },
    [isValidConnection, setDesign],
  );

  // ───── adding machines ─────
  const addAt = useCallback(
    (kind: PaletteKind, pos: { x: number; y: number }) => {
      let id = '';
      setDesign((d) => {
        const m = newMachine(kind, d, inv, pos);
        id = m.id;
        return { ...d, machines: [...d.machines, m] };
      });
      setTimeout(() => setSelectedId(id), 0);
    },
    [inv, setDesign],
  );

  const addCentered = (kind: PaletteKind) => {
    const r = wrapper.current?.getBoundingClientRect();
    const center = r ? screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 }) : { x: 0, y: 0 };
    const n = design.machines.length;
    addAt(kind, { x: center.x - BLUEPRINT_SIZE.w / 2 + (n % 4) * 24, y: center.y - BLUEPRINT_SIZE.h / 2 + (n % 4) * 24 });
  };

  const onDrop = (e: DragEvent) => {
    const kind = e.dataTransfer.getData(DRAG_TYPE) as PaletteKind;
    if (!kind) return;
    e.preventDefault();
    const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
    addAt(kind, { x: p.x - BLUEPRINT_SIZE.w / 2, y: p.y - 20 });
  };

  // Fit-to-view must wait until React Flow has measured every card, or new cards end up off-screen.
  const [canvasFocus, setCanvasFocus] = useState(false);
  const pendingFit = useRef(true); // true → fit the first time the screen is visible with cards on it
  const usePreset = (p: Preset) => {
    if (design.machines.length && !window.confirm(`Replace the ${design.machines.length} machine(s) on the canvas with "${p.label}"?`)) return;
    setDesign((d) => applyPreset(d, p, inv));
    setSelectedId(null);
    pendingFit.current = true;
  };
  useEffect(() => {
    if (!active || !pendingFit.current || !nodes.length) return;
    if (nodes.length !== design.machines.length || !nodes.every((n) => n.measured?.width)) return;
    pendingFit.current = false;
    requestAnimationFrame(() => fitView({ padding: 0.12, duration: 300, maxZoom: 1 }));
  }, [active, nodes, design.machines.length, fitView]);

  const [paletteCompact, setPaletteCompact] = useState(() => {
    const saved = localStorage.getItem('proxflow.palette');
    return saved ? saved === 'compact' : window.innerWidth < 1500; // narrow screens: give the canvas the room
  });
  useEffect(() => localStorage.setItem('proxflow.palette', paletteCompact ? 'compact' : 'full'), [paletteCompact]);

  const selected = design.machines.find((m) => m.id === selectedId);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 overflow-hidden border-b border-zinc-800 bg-zinc-950/95 px-3 md:gap-3 md:px-4">
        <Brand />
        <ModeSwitch mode={common.mode} onMode={common.onMode} />
        <div className="flex min-w-0 items-center gap-2">
          <Hammer className="hidden h-4 w-4 shrink-0 text-zinc-600 sm:block" />
          <input
            value={design.name}
            onChange={(e) => setDesign((d) => ({ ...d, name: e.target.value }))}
            className="h-8 w-44 min-w-0 rounded-lg border border-transparent bg-transparent px-2 text-sm font-medium text-zinc-100 hover:border-zinc-800 focus:border-sky-500/60 focus:outline-none"
            title="Lab name"
          />
        </div>
        <div className="flex-1" />
        <span className={clsx('hidden whitespace-nowrap text-xs lg:inline', errorCount ? 'text-rose-300' : 'text-zinc-500')}>
          {design.machines.length} machine{design.machines.length === 1 ? '' : 's'}
          {errorCount ? ` · ${errorCount} to fix` : design.machines.length ? ' · looks good' : ''}
        </span>
        <ActionButton tone="sky" icon={Rocket} disabled={!design.machines.length || deploying || !design.target.conn} onClick={() => setDeployOpen(true)} title={deploying ? 'A deployment is running' : undefined}>
          Review &amp; deploy
        </ActionButton>
        <div className="mx-1 h-5 w-px bg-zinc-800" />
        <ConnectionButton connections={conns} onOpen={common.onOpenConnections} />
      </header>

      <div className="flex min-h-0 flex-1">
        <Palette
          inv={inv}
          onAdd={addCentered}
          onPreset={usePreset}
          disabled={!design.target.conn}
          compact={paletteCompact}
          onToggleCompact={() => setPaletteCompact((c) => !c)}
        />

        <div ref={wrapper} className="relative min-w-0 flex-1" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
          <ReactFlow<BlueprintFlowNode, Edge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onPaneClick={() => setSelectedId(null)}
            colorMode="dark"
            // Delete/Backspace only while the canvas has focus: React Flow listens on the whole page, so a
            // Backspace after clicking a button in the side panel would otherwise delete the selected machine.
            onFocus={() => setCanvasFocus(true)}
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setCanvasFocus(false);
            }}
            deleteKeyCode={active && canvasFocus ? ['Delete', 'Backspace'] : null}
            connectionLineStyle={{ stroke: '#8b5cf6', strokeWidth: 2 }}
            minZoom={0.2}
            maxZoom={1.8}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1.4} color="#27272a" />
            <Controls showInteractive={false} position="top-left" />
          </ReactFlow>

          {design.machines.length === 0 && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="max-w-sm rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/70 p-6 text-center">
                <Hammer className="mx-auto mb-2 h-6 w-6 text-zinc-600" />
                <h2 className="text-sm font-semibold text-zinc-200">Design a lab</h2>
                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                  {design.target.conn
                    ? 'Drag machines from the left, or pick a preset. Draw a line from a server to a domain controller to join its domain.'
                    : 'Connect to a Proxmox host first — then drag machines here.'}
                </p>
              </div>
            </div>
          )}

          {dep && (
            <DeploymentPanel dep={dep} onShowOnMap={onShowOnMap} onDismiss={() => setDesign((d) => ({ ...d, activeDeployment: undefined }))} />
          )}
        </div>

        <aside className="scroll-thin w-[340px] shrink-0 overflow-y-auto border-l border-zinc-800 bg-zinc-950/80 p-4">
          {selected ? (
            <MachinePanel
              key={selected.id}
              machine={selected}
              design={design}
              inv={inv}
              issues={issues.filter((i) => i.machine === selected.id)}
              onChange={(m) => setDesign((d) => ({ ...d, machines: d.machines.map((x) => (x.id === m.id ? m : x)) }))}
              onDelete={() => {
                removeMachines([selected.id]);
                setSelectedId(null);
              }}
            />
          ) : (
            <LabPanel
              design={design}
              setDesign={setDesign}
              connections={conns}
              inv={inv}
              invLoading={invQ.isFetching}
              invError={invQ.error?.message}
              issues={issues}
              onRefreshInventory={() => void invQ.refetch()}
            />
          )}
        </aside>
      </div>

      <DeployDialog
        open={deployOpen}
        spec={spec}
        onClose={() => setDeployOpen(false)}
        onDeployed={(d) => {
          setDeployOpen(false);
          setDesign((x) => ({ ...x, activeDeployment: d.id }));
        }}
      />
    </div>
  );
}
