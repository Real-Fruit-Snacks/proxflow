import type { NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { Boxes, Share2, TriangleAlert, type LucideIcon } from 'lucide-react';
import type { BandFlowNode, BandTone } from '../layout';

const TONES: Record<BandTone, { box: string; icon: LucideIcon; iconCls: string; title: string }> = {
  cluster: { box: 'border-zinc-700/70 bg-zinc-900/50', icon: Boxes, iconCls: 'text-zinc-400', title: 'text-zinc-100' },
  shared: { box: 'border-dashed border-amber-500/25 bg-amber-500/[0.03]', icon: Share2, iconCls: 'text-amber-300/80', title: 'text-amber-200/80 uppercase tracking-wider text-xs' },
  error: { box: 'border-rose-500/40 bg-rose-500/[0.06]', icon: TriangleAlert, iconCls: 'text-rose-300', title: 'text-rose-100' },
};

/** Decorative container / label strip. Not selectable; any children are real nodes. */
export function BandNode({ data }: NodeProps<BandFlowNode>) {
  const t = TONES[data.tone];
  const Icon = t.icon;
  return (
    <div className={clsx('h-full w-full rounded-2xl border', t.box)}>
      <div className="flex h-10 items-center gap-2.5 px-4">
        <Icon className={clsx('h-4 w-4 shrink-0', t.iconCls)} />
        <span className={clsx('truncate text-sm font-semibold', t.title)}>{data.name}</span>
        {data.subtitle && <span className="min-w-0 truncate text-[11px] text-zinc-500">· {data.subtitle}</span>}
      </div>
    </div>
  );
}
