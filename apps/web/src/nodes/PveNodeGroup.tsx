import type { NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { Server } from 'lucide-react';
import { MetricBar } from '../components/MetricBar';
import type { PveFlowNode } from '../layout';
import { fmtBytes, fmtUptime } from '../lib/format';

export function PveNodeGroup({ data, selected }: NodeProps<PveFlowNode>) {
  const online = data.status === 'online';
  return (
    <div
      className={clsx(
        'h-full w-full rounded-2xl border bg-zinc-900/40 shadow-xl shadow-black/20',
        online ? 'border-zinc-700/80' : 'border-rose-500/40',
        selected && 'ring-2 ring-sky-400/60',
      )}
    >
      <div className="flex h-14 items-center gap-3 border-b border-zinc-800/80 px-4">
        <div
          className={clsx(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
            online ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300',
          )}
        >
          <Server className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-zinc-100">{data.name}</div>
          <div className="truncate text-[11px] text-zinc-500">
            {data.status} · up {fmtUptime(data.uptime)} · {data.maxcpu} cores · {fmtBytes(data.maxmem)}
          </div>
        </div>
        <div className="ml-auto grid w-60 shrink-0 grid-cols-2 gap-3">
          <MetricBar label="CPU" value={data.cpu} />
          <MetricBar label="RAM" value={data.maxmem ? data.mem / data.maxmem : 0} hint={fmtBytes(data.mem)} />
        </div>
      </div>
    </div>
  );
}
