import clsx from 'clsx';
import { Camera, Container, HardDrive, Layers, Monitor, Network, Play, Power, RotateCw, Server, Square, Trash2, X } from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import { ids, type BridgeData, type GuestAction, type GuestData, type PveNodeData, type StorageData, type Topology } from '@proxflow/shared';
import { useGuestAction, useSnapshotMutation, useSnapshots } from '../api';
import type { InspectableNode as FlowNode } from '../layout';
import { fmtBytes, fmtGiB, fmtUptime, pct } from '../lib/format';
import { Badge, type Tone } from './Badge';
import { ActionButton, ConfirmButton } from './ConfirmButton';
import { MetricBar } from './MetricBar';

type Props = { node: FlowNode; topo: Topology; onClose: () => void; onSelect: (id: string) => void };

const STATUS_TONE: Record<string, Tone> = { running: 'emerald', stopped: 'zinc', paused: 'amber', suspended: 'amber', online: 'emerald', offline: 'rose' };

export function Inspector({ node, topo, onClose, onSelect }: Props) {
  const d = node.data;
  return (
    <aside className="absolute bottom-3 right-3 top-3 z-20 flex w-[380px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/95 shadow-2xl shadow-black/60 backdrop-blur-md">
      <header className="flex items-start gap-3 border-b border-zinc-800 px-4 py-3">
        <Header data={d} />
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-md p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          title="Close (Esc)"
        >
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="scroll-thin flex-1 space-y-5 overflow-y-auto p-4">
        {d.kind === 'guest' && <GuestPanel guest={d} topo={topo} onSelect={onSelect} />}
        {d.kind === 'node' && <NodePanel node={d} topo={topo} onSelect={onSelect} />}
        {d.kind === 'bridge' && <BridgePanel bridge={d} id={node.id} topo={topo} onSelect={onSelect} />}
        {d.kind === 'storage' && <StoragePanel storage={d} id={node.id} topo={topo} onSelect={onSelect} />}
      </div>
    </aside>
  );
}

// ───── header ─────

function Header({ data }: { data: FlowNode['data'] }) {
  const icon = {
    guest: data.kind === 'guest' ? (data.template ? Layers : data.type === 'qemu' ? Monitor : Container) : Monitor,
    node: Server,
    bridge: Network,
    storage: HardDrive,
  }[data.kind];
  const Icon = icon;
  const tone: Record<FlowNode['data']['kind'], string> = {
    guest: 'bg-violet-500/10 text-violet-300',
    node: 'bg-emerald-500/10 text-emerald-300',
    bridge: 'bg-sky-500/10 text-sky-300',
    storage: 'bg-amber-500/10 text-amber-300',
  };
  const subtitle =
    data.kind === 'guest'
      ? `${data.type === 'qemu' ? 'Virtual machine' : 'LXC container'} · ${data.vmid} · on ${data.node}`
      : data.kind === 'node'
        ? 'Proxmox node'
        : data.kind === 'bridge'
          ? `Linux bridge on ${data.node}`
          : `${data.type} storage${data.shared ? ' · shared' : ` · ${data.nodes[0] ?? ''}`}`;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-lg', tone[data.kind])}>
        <Icon className="h-4.5 w-4.5" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-sm font-semibold text-zinc-100">{data.name}</h2>
          {data.kind === 'guest' && !data.template && <Badge tone={STATUS_TONE[data.status] ?? 'rose'}>{data.status}</Badge>}
          {data.kind === 'guest' && data.template && <Badge>template</Badge>}
          {data.kind === 'node' && <Badge tone={STATUS_TONE[data.status] ?? 'rose'}>{data.status}</Badge>}
        </div>
        <div className="truncate text-[11px] text-zinc-500">{subtitle}</div>
      </div>
    </div>
  );
}

// ───── building blocks ─────

function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function KV({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
      {rows.map(([k, v]) => (
        <Fragment key={k}>
          <dt className="text-zinc-500">{k}</dt>
          <dd className="min-w-0 truncate text-right tabular-nums text-zinc-200">{v}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function LinkButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} className="text-sky-300 hover:underline">
      {children}
    </button>
  );
}

function GuestRow({ g, onSelect, note }: { g: GuestData; onSelect: (id: string) => void; note?: string }) {
  const dot = g.status === 'running' ? 'bg-emerald-400' : g.status === 'stopped' ? 'bg-zinc-600' : 'bg-amber-400';
  return (
    <button
      type="button"
      onClick={() => onSelect(ids.guest(g.conn, g.vmid))}
      className="flex w-full items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-left text-xs transition-colors hover:border-zinc-700 hover:bg-zinc-800/80"
    >
      <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', g.template ? 'bg-zinc-700' : dot)} />
      <span className="truncate font-medium text-zinc-200">{g.name}</span>
      <span className="font-mono text-[10px] text-zinc-500">{g.vmid}</span>
      {note && <span className="truncate font-mono text-[10px] text-zinc-500">· {note}</span>}
      <Badge className="ml-auto" tone={g.type === 'qemu' ? 'violet' : 'sky'}>
        {g.type === 'qemu' ? 'VM' : 'CT'}
      </Badge>
    </button>
  );
}

const guestById = (topo: Topology) => {
  const m = new Map<string, GuestData>();
  for (const n of topo.nodes) if (n.data.kind === 'guest') m.set(n.id, n.data);
  return m;
};

/** Guests with an edge pointing at `targetId`, plus the edge label (net0 / scsi0 …). */
function attachedGuests(topo: Topology, targetId: string): { g: GuestData; label?: string }[] {
  const guests = guestById(topo);
  return topo.edges
    .filter((e) => e.target === targetId)
    .flatMap((e) => {
      const g = guests.get(e.source);
      return g ? [{ g, label: e.label }] : [];
    })
    .sort((a, b) => a.g.vmid - b.g.vmid);
}

function findStorageId(topo: Topology, conn: string, node: string, name: string): string | undefined {
  const hit = topo.nodes.find(
    (n) => n.data.kind === 'storage' && n.data.conn === conn && n.data.name === name && (n.data.shared || n.data.nodes.includes(node)),
  );
  return hit?.id;
}

// ───── panels ─────

function GuestPanel({ guest, topo, onSelect }: { guest: GuestData; topo: Topology; onSelect: (id: string) => void }) {
  const act = useGuestAction();
  const running = guest.status === 'running';
  const stopped = guest.status === 'stopped';
  const paused = guest.status === 'paused' || guest.status === 'suspended';
  const busy = act.isPending;
  const run = (action: GuestAction) => act.mutate({ guest, action, vmid: guest.vmid });

  return (
    <>
      {!guest.template && (
        <Section title="Actions">
          <div className="grid grid-cols-2 gap-2">
            {stopped && (
              <ActionButton icon={Play} tone="emerald" onClick={() => run('start')} disabled={busy}>
                Start
              </ActionButton>
            )}
            {paused && (
              <ActionButton icon={Play} tone="emerald" onClick={() => run('resume')} disabled={busy}>
                Resume
              </ActionButton>
            )}
            {running && (
              <ActionButton icon={Power} onClick={() => run('shutdown')} disabled={busy}>
                Shutdown
              </ActionButton>
            )}
            {running && (
              <ConfirmButton icon={RotateCw} onConfirm={() => run('reboot')} disabled={busy}>
                Reboot
              </ConfirmButton>
            )}
            {running && (
              <ConfirmButton icon={Square} tone="amber" onConfirm={() => run('stop')} disabled={busy} confirmLabel="Force stop?">
                Stop
              </ConfirmButton>
            )}
          </div>
        </Section>
      )}

      <Section title="Overview">
        <KV
          rows={[
            ['Node', <LinkButton onClick={() => onSelect(ids.node(guest.conn, guest.node))}>{guest.node}</LinkButton>],
            ['vCPU', guest.maxcpu],
            ['Memory', fmtBytes(guest.maxmem)],
            ['Disk', fmtBytes(guest.maxdisk)],
            ['OS type', guest.ostype ?? '—'],
            ['Uptime', running ? fmtUptime(guest.uptime) : '—'],
          ]}
        />
      </Section>

      {running && (
        <Section title="Live">
          <MetricBar label="CPU" value={guest.cpu} hint={`${pct(guest.cpu)} of ${guest.maxcpu} vCPU`} />
          <MetricBar
            className="mt-3"
            label="Memory"
            value={guest.maxmem ? guest.mem / guest.maxmem : 0}
            hint={`${fmtBytes(guest.mem)} / ${fmtBytes(guest.maxmem)}`}
          />
        </Section>
      )}

      {guest.tags.length > 0 && (
        <Section title="Tags">
          <div className="flex flex-wrap gap-1.5">
            {guest.tags.map((t) => (
              <span key={t} className="rounded-md bg-zinc-800 px-2 py-0.5 text-[11px] text-zinc-300">
                {t}
              </span>
            ))}
          </div>
        </Section>
      )}

      <Section title={`Network (${guest.nets.length})`}>
        <div className="space-y-1.5">
          {guest.nets.map((n) => (
            <div key={n.key} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-zinc-400">{n.key}</span>
                {n.bridge && <LinkButton onClick={() => onSelect(ids.bridge(guest.conn, guest.node, n.bridge!))}>{n.bridge}</LinkButton>}
                {n.vlan !== undefined && <Badge tone="sky">VLAN {n.vlan}</Badge>}
                {n.firewall && <Badge>fw</Badge>}
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">
                {[n.model ?? n.name, n.mac, n.ip, n.gateway && `gw ${n.gateway}`].filter(Boolean).join(' · ')}
              </div>
            </div>
          ))}
          {guest.nets.length === 0 && <p className="text-xs text-zinc-500">No network interfaces.</p>}
        </div>
      </Section>

      <Section title={`Disks (${guest.disks.length})`}>
        <div className="space-y-1.5">
          {guest.disks.map((d) => {
            const sid = findStorageId(topo, guest.conn, guest.node, d.storage);
            return (
              <div key={d.key} className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-zinc-400">{d.key}</span>
                  {sid ? <LinkButton onClick={() => onSelect(sid)}>{d.storage}</LinkButton> : <span className="text-zinc-300">{d.storage}</span>}
                  <span className="ml-auto tabular-nums text-zinc-300">{fmtGiB(d.sizeGiB)}</span>
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">
                  {d.volume}
                  {d.mountPoint && ` → ${d.mountPoint}`}
                </div>
              </div>
            );
          })}
          {guest.disks.length === 0 && <p className="text-xs text-zinc-500">No disks on managed storage.</p>}
        </div>
      </Section>

      <SnapshotsSection guest={guest} />
    </>
  );
}

function SnapshotsSection({ guest }: { guest: GuestData }) {
  const q = useSnapshots(guest);
  const m = useSnapshotMutation();
  const [name, setName] = useState('');
  const snaps = (q.data ?? []).filter((s) => !s.current);
  const valid = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(name);

  return (
    <Section title={`Snapshots (${snaps.length})`}>
      <div className="space-y-1.5">
        {snaps.map((s) => (
          <div key={s.name} className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
            <Camera className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 truncate font-medium text-zinc-200">
                {s.name}
                {s.vmstate && <Badge>RAM</Badge>}
              </div>
              <div className="truncate text-[11px] text-zinc-500">
                {s.description || (s.snaptime ? new Date(s.snaptime * 1000).toLocaleString() : '')}
              </div>
            </div>
            <ConfirmButton size="sm" icon={Trash2} confirmLabel="Delete?" onConfirm={() => m.mutate({ guest, name: s.name, remove: true })} disabled={m.isPending} />
          </div>
        ))}
        {snaps.length === 0 && !q.isLoading && <p className="text-xs text-zinc-500">No snapshots yet.</p>}
        {q.isError && <p className="text-xs text-rose-300">{q.error.message}</p>}
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          m.mutate({ guest, name });
          setName('');
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="snapshot-name"
          spellCheck={false}
          className="h-8 min-w-0 flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500/60 focus:outline-none"
        />
        <ActionButton type="submit" icon={Camera} tone="sky" disabled={!valid || m.isPending}>
          Take
        </ActionButton>
      </form>
    </Section>
  );
}

function NodePanel({ node, topo, onSelect }: { node: PveNodeData; topo: Topology; onSelect: (id: string) => void }) {
  const guests = topo.nodes
    .flatMap((n) => (n.data.kind === 'guest' && n.data.conn === node.conn && n.data.node === node.name ? [n.data] : []))
    .sort((a, b) => Number(a.template) - Number(b.template) || a.vmid - b.vmid);
  const running = guests.filter((g) => g.status === 'running').length;
  return (
    <>
      <Section title="Overview">
        <KV
          rows={[
            ['Uptime', fmtUptime(node.uptime)],
            ['CPU', `${node.maxcpu} cores`],
            ['Memory', fmtBytes(node.maxmem)],
            ['Root disk', fmtBytes(node.maxdisk)],
            ['Guests', `${running} running / ${guests.length}`],
          ]}
        />
      </Section>
      <Section title="Live">
        <MetricBar label="CPU" value={node.cpu} />
        <MetricBar className="mt-3" label="Memory" value={node.maxmem ? node.mem / node.maxmem : 0} hint={`${fmtBytes(node.mem)} / ${fmtBytes(node.maxmem)}`} />
        <MetricBar className="mt-3" label="Root disk" value={node.maxdisk ? node.disk / node.maxdisk : 0} hint={`${fmtBytes(node.disk)} / ${fmtBytes(node.maxdisk)}`} />
      </Section>
      <Section title={`Guests (${guests.length})`}>
        <div className="space-y-1.5">
          {guests.map((g) => (
            <GuestRow key={g.vmid} g={g} onSelect={onSelect} />
          ))}
        </div>
      </Section>
    </>
  );
}

function BridgePanel({ bridge, id, topo, onSelect }: { bridge: BridgeData; id: string; topo: Topology; onSelect: (id: string) => void }) {
  const attached = attachedGuests(topo, id);
  return (
    <>
      <Section title="Overview">
        <KV
          rows={[
            ['Node', <LinkButton onClick={() => onSelect(ids.node(bridge.conn, bridge.node))}>{bridge.node}</LinkButton>],
            ['Address', bridge.cidr ?? '—'],
            ['Gateway', bridge.gateway ?? '—'],
            ['Ports', bridge.ports.length ? bridge.ports.join(', ') : 'none (internal)'],
            ['VLAN aware', bridge.vlanAware ? 'yes' : 'no'],
            ['Active', bridge.active ? 'yes' : 'no'],
          ]}
        />
      </Section>
      <Section title={`Attached guests (${attached.length})`}>
        <div className="space-y-1.5">
          {attached.map(({ g, label }) => (
            <GuestRow key={`${g.vmid}-${label}`} g={g} onSelect={onSelect} note={label} />
          ))}
          {attached.length === 0 && <p className="text-xs text-zinc-500">Nothing attached.</p>}
        </div>
      </Section>
    </>
  );
}

function StoragePanel({ storage, id, topo, onSelect }: { storage: StorageData; id: string; topo: Topology; onSelect: (id: string) => void }) {
  const users = attachedGuests(topo, id);
  return (
    <>
      <Section title="Overview">
        <KV
          rows={[
            ['Type', storage.type],
            ['Scope', storage.shared ? `shared (${storage.nodes.join(', ')})` : `local to ${storage.nodes[0] ?? '?'}`],
            ['Content', storage.content.join(', ') || '—'],
            ['Active', storage.active ? 'yes' : 'no'],
          ]}
        />
        <MetricBar className="mt-3" label="Usage" value={storage.total ? storage.used / storage.total : 0} hint={`${fmtBytes(storage.used)} / ${fmtBytes(storage.total)}`} />
      </Section>
      <Section title={`Used by (${users.length})`}>
        <div className="space-y-1.5">
          {users.map(({ g, label }) => (
            <GuestRow key={g.vmid} g={g} onSelect={onSelect} note={label} />
          ))}
          {users.length === 0 && <p className="text-xs text-zinc-500">No guest disks here.</p>}
        </div>
      </Section>
    </>
  );
}
