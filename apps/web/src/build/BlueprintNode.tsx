import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, CircleDashed, LoaderCircle, XCircle } from 'lucide-react';
import type { DeploymentMachine } from '@proxflow/shared';
import type { DesignMachine } from './design';
import { KIND_STYLES, fmtMem, paletteKindOf } from './labels';

export type BlueprintData = {
  machine: DesignMachine;
  source: string;
  errors: number;
  warnings: number;
  domain?: string; // DC: its domain; members: the domain they join
  /** Is there a domain controller in the lab to join? (controls the join dot + hint) */
  hasDc: boolean;
  run?: DeploymentMachine;
};
export type BlueprintFlowNode = Node<BlueprintData, 'blueprint'>;

export const BLUEPRINT_SIZE = { w: 252, h: 132 };

const RUN_STYLE: Record<DeploymentMachine['status'], { icon: typeof CheckCircle2; cls: string; label: string }> = {
  pending: { icon: CircleDashed, cls: 'text-zinc-400', label: 'Waiting' },
  building: { icon: LoaderCircle, cls: 'text-sky-300', label: 'Building' },
  ready: { icon: CheckCircle2, cls: 'text-emerald-300', label: 'Ready' },
  warning: { icon: AlertTriangle, cls: 'text-amber-300', label: 'Ready (check)' },
  failed: { icon: XCircle, cls: 'text-rose-300', label: 'Failed' },
  cancelled: { icon: XCircle, cls: 'text-zinc-400', label: 'Cancelled' },
};

const handleStyle = { width: 10, height: 10, background: '#8b5cf6', border: '2px solid #18181b' };

export function BlueprintNode({ data, selected }: NodeProps<BlueprintFlowNode>) {
  const m = data.machine;
  const kind = paletteKindOf(m);
  const style = KIND_STYLES[kind];
  const Icon = style.icon;
  const run = data.run;
  const rs = run ? RUN_STYLE[run.status] : undefined;
  // Members sit below their DC: the join dot is on top of members and at the bottom of DCs,
  // so a join line runs straight up instead of looping around the cards.
  const canJoin = (m.kind === 'linux-vm' || (m.kind === 'windows' && m.role === 'server')) && data.hasDc;
  const joined = 'joinDomainOf' in m && Boolean(m.joinDomainOf);
  const isDc = m.kind === 'windows' && m.role === 'dc';

  return (
    <div
      className={clsx(
        'flex h-full w-full flex-col justify-between rounded-xl border bg-zinc-900 px-3 py-2 shadow-lg shadow-black/40',
        selected ? 'border-sky-400/80 ring-2 ring-sky-400/70' : data.errors ? 'border-rose-500/50' : style.ring,
      )}
    >
      {canJoin && <Handle type="source" id="join" position={Position.Top} style={handleStyle} title="Drag to a domain controller to join its domain" />}

      <div className="flex min-w-0 items-center gap-2">
        <div className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', style.tint)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-zinc-100">{m.name || 'unnamed'}</div>
          <div className="truncate text-[10px] text-zinc-500">
            {style.label}
            {data.domain ? ` · ${isDc ? '' : 'joins '}${data.domain}` : ''}
          </div>
        </div>
        {run?.vmid ? <span className="shrink-0 font-mono text-[10px] text-zinc-500">{run.vmid}</span> : null}
      </div>

      <div className="space-y-0.5 text-[11px] leading-4">
        <div className="truncate text-zinc-300">{data.source}</div>
        <div className="truncate text-zinc-500">
          {m.cores} vCPU · {fmtMem(m.memoryMiB)} · {m.diskGiB} GiB ·{' '}
          <span className="font-mono">{run?.ip ?? (m.net.ipMode === 'static' ? (m.net.cidr ?? 'static ?') : 'DHCP')}</span>
          {m.net.vlan ? ` · VLAN ${m.net.vlan}` : ''}
        </div>
      </div>

      {run && rs ? (
        <div className="min-w-0">
          <div className={clsx('flex min-w-0 items-center gap-1.5 text-[11px]', rs.cls)}>
            <rs.icon className={clsx('h-3.5 w-3.5 shrink-0', run.status === 'building' && 'animate-spin')} />
            <span className="shrink-0 font-medium">{rs.label}</span>
            {run.message && <span className="truncate text-zinc-500">· {run.message}</span>}
          </div>
          {run.total > 0 && (
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800">
              <div
                className={clsx('h-full rounded-full transition-[width] duration-500', run.status === 'failed' ? 'bg-rose-400' : run.status === 'warning' ? 'bg-amber-400' : 'bg-sky-400')}
                style={{ width: `${(run.done / run.total) * 100}%` }}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[10px]">
          {data.errors > 0 && <span className="rounded bg-rose-500/15 px-1.5 py-px font-medium text-rose-300">{data.errors} to fix</span>}
          {data.warnings > 0 && <span className="rounded bg-amber-500/10 px-1.5 py-px text-amber-300/90">{data.warnings} note{data.warnings > 1 ? 's' : ''}</span>}
          {!data.errors && !data.warnings && <span className="text-zinc-600">ready to deploy</span>}
          {canJoin && !joined && <span className="ml-auto text-zinc-600">drag the top ● to a DC to join</span>}
        </div>
      )}

      {isDc && <Handle type="target" id="domain" position={Position.Bottom} style={handleStyle} title="Drop a join line here" />}
    </div>
  );
}
