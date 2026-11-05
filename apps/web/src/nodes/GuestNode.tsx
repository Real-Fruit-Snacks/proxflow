import { Handle, Position, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { Container, HardDrive, Layers, LoaderCircle, Monitor, Network } from 'lucide-react';
import type { GuestStatus } from '@proxflow/shared';
import { Badge } from '../components/Badge';
import { MetricBar } from '../components/MetricBar';
import type { GuestFlowNode } from '../layout';
import { fmtBytes, fmtUptime, pct } from '../lib/format';

const STATUS: Record<GuestStatus, { dot: string; border: string; label: string }> = {
  running: { dot: 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]', border: 'border-emerald-500/30', label: 'running' },
  stopped: { dot: 'bg-zinc-600', border: 'border-zinc-700/80', label: 'stopped' },
  paused: { dot: 'bg-amber-400', border: 'border-amber-500/30', label: 'paused' },
  suspended: { dot: 'bg-amber-400', border: 'border-amber-500/30', label: 'suspended' },
  unknown: { dot: 'bg-rose-400', border: 'border-rose-500/30', label: 'unknown' },
};

const MAX_CHIPS = 4;

function Chip({ tone, icon: Icon, children }: { tone: 'sky' | 'amber'; icon: typeof Network; children: string }) {
  return (
    <span
      className={clsx(
        'inline-flex max-w-[110px] items-center gap-1 rounded px-1.5 py-px font-mono text-[10px] leading-4',
        tone === 'sky' ? 'bg-sky-500/10 text-sky-300/90' : 'bg-amber-500/10 text-amber-300/90',
      )}
    >
      <Icon className="h-2.5 w-2.5 shrink-0 opacity-70" />
      <span className="truncate">{children}</span>
    </span>
  );
}

export function GuestNode({ data, selected }: NodeProps<GuestFlowNode>) {
  const s = STATUS[data.status] ?? STATUS.unknown;
  const running = data.status === 'running';
  const Icon = data.template ? Layers : data.type === 'qemu' ? Monitor : Container;
  const stopped = !running && !data.template;

  // Attachment chips: bridge (+VLAN) per NIC, then each distinct storage.
  const netChips = data.nets.filter((n) => n.bridge).map((n) => `${n.bridge}${n.vlan ? `·${n.vlan}` : ''}`);
  const storageChips = [...new Set(data.disks.map((d) => d.storage))];
  const chips = [
    ...netChips.map((c) => ({ tone: 'sky' as const, icon: Network, label: c })),
    ...storageChips.map((c) => ({ tone: 'amber' as const, icon: HardDrive, label: c })),
  ];
  const overflow = chips.length - MAX_CHIPS;

  return (
    <div
      className={clsx(
        'relative flex h-full w-full flex-col justify-between rounded-xl border bg-zinc-900 px-3 py-2 shadow-lg shadow-black/30 transition-colors',
        data.template ? 'border-dashed border-zinc-700' : s.border,
        stopped && 'bg-[#141417]',
        selected && 'border-sky-400/70 ring-2 ring-sky-400/80',
      )}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />

      <div className="flex min-w-0 items-center gap-2">
        <span className={clsx('h-2 w-2 shrink-0 rounded-full', data.template ? 'bg-zinc-600' : s.dot)} />
        <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <span className={clsx('truncate text-[13px] font-semibold', stopped ? 'text-zinc-400' : 'text-zinc-100')}>{data.name}</span>
        <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-500">{data.vmid}</span>
      </div>

      {data.template ? (
        <div className="text-[11px] text-zinc-500">
          Template · {data.maxcpu} vCPU · {fmtBytes(data.maxmem)}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <MetricBar label="CPU" value={running ? data.cpu : 0} hint={running ? pct(data.cpu) : '—'} />
          <MetricBar
            label="RAM"
            value={running && data.maxmem ? data.mem / data.maxmem : 0}
            hint={running ? fmtBytes(data.mem) : fmtBytes(data.maxmem)}
          />
        </div>
      )}

      <div className="flex min-w-0 items-center gap-1 overflow-hidden">
        {chips.slice(0, MAX_CHIPS).map((c, i) => (
          <Chip key={i} tone={c.tone} icon={c.icon}>
            {c.label}
          </Chip>
        ))}
        {overflow > 0 && <span className="text-[10px] text-zinc-500">+{overflow}</span>}
        {chips.length === 0 && <span className="text-[10px] text-zinc-600">no attachments</span>}
      </div>

      <div className="flex min-w-0 items-center gap-1">
        <Badge tone={data.type === 'qemu' ? 'violet' : 'sky'}>{data.type === 'qemu' ? 'VM' : 'CT'}</Badge>
        {data.tags.slice(0, 3).map((t) => (
          <span key={t} className="truncate rounded bg-zinc-800 px-1.5 py-px text-[10px] leading-4 text-zinc-400">
            {t}
          </span>
        ))}
        <span className="ml-auto shrink-0 text-[10px] text-zinc-500">{running ? fmtUptime(data.uptime) : data.template ? '' : s.label}</span>
      </div>

      {data.pending && (
        <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-zinc-950/60">
          <LoaderCircle className="h-5 w-5 animate-spin text-sky-300" />
        </div>
      )}

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, pointerEvents: 'none' }} />
    </div>
  );
}
