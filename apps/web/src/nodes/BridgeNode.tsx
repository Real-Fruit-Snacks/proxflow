import { Handle, Position, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { Network } from 'lucide-react';
import { Badge } from '../components/Badge';
import type { BridgeFlowNode } from '../layout';

export function BridgeNode({ data, selected }: NodeProps<BridgeFlowNode>) {
  return (
    <div
      className={clsx(
        'flex h-full w-full items-center gap-2.5 rounded-lg border bg-zinc-900/95 px-3 shadow-md shadow-black/20',
        data.active ? 'border-sky-500/30' : 'border-zinc-700',
        selected && 'border-sky-400/70 ring-2 ring-sky-400/80',
      )}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0, pointerEvents: 'none' }} />
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-sky-500/10 text-sky-300">
        <Network className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-100">
          <span className="truncate">{data.name}</span>
          {data.vlanAware && <Badge tone="sky">vlan</Badge>}
        </div>
        <div className="truncate text-[10px] text-zinc-500">
          {data.cidr ?? 'no address'}
          {data.ports.length ? ` · ${data.ports.join(', ')}` : ' · internal'}
        </div>
      </div>
    </div>
  );
}
