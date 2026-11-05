import { Handle, Position, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { HardDrive } from 'lucide-react';
import { Badge } from '../components/Badge';
import { MetricBar } from '../components/MetricBar';
import type { StorageFlowNode } from '../layout';
import { fmtBytes } from '../lib/format';

export function StorageNode({ data, selected }: NodeProps<StorageFlowNode>) {
  return (
    <div
      className={clsx(
        'flex h-full w-full items-center gap-2.5 rounded-lg border bg-zinc-900/95 px-3 shadow-md shadow-black/20',
        data.active ? 'border-amber-500/30' : 'border-zinc-700',
        selected && 'border-sky-400/70 ring-2 ring-sky-400/80',
      )}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-amber-500/10 text-amber-300">
        <HardDrive className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-100">
          <span className="truncate">{data.name}</span>
          {data.shared && <Badge tone="amber">shared</Badge>}
          <span className="ml-auto shrink-0 text-[10px] font-normal text-zinc-500">{data.type}</span>
        </div>
        <MetricBar
          className="mt-1.5"
          value={data.total ? data.used / data.total : 0}
          hint={`${fmtBytes(data.used)} / ${fmtBytes(data.total)}`}
        />
      </div>
    </div>
  );
}
