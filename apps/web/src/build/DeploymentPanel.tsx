import clsx from 'clsx';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, CircleDashed, Copy, LoaderCircle, MapPin, Square, Trash2, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { Deployment, DeploymentMachine, StepStatus } from '@proxflow/shared';
import { ConfirmButton } from '../components/ConfirmButton';
import { copyText } from '../lib/clipboard';
import { useDeploymentAction } from './api';

const MACHINE: Record<DeploymentMachine['status'], { icon: typeof CheckCircle2; cls: string; label: string }> = {
  pending: { icon: CircleDashed, cls: 'text-zinc-500', label: 'Waiting' },
  building: { icon: LoaderCircle, cls: 'text-sky-300', label: 'Building' },
  ready: { icon: CheckCircle2, cls: 'text-emerald-300', label: 'Ready' },
  warning: { icon: AlertTriangle, cls: 'text-amber-300', label: 'Check' },
  failed: { icon: XCircle, cls: 'text-rose-300', label: 'Failed' },
  cancelled: { icon: XCircle, cls: 'text-zinc-500', label: 'Cancelled' },
};
const STEP: Record<StepStatus, string> = {
  pending: 'text-zinc-600',
  running: 'text-sky-300',
  done: 'text-emerald-400',
  warning: 'text-amber-300',
  failed: 'text-rose-300',
  skipped: 'text-zinc-600',
  cancelled: 'text-zinc-600',
};
const STATUS_TEXT: Record<Deployment['status'], string> = {
  running: 'Deploying',
  succeeded: 'Deployed',
  warning: 'Deployed — check the notes',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted (ProxFlow restarted)',
  destroying: 'Destroying',
  destroyed: 'Destroyed',
};

function useElapsed(from: string, to?: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (to) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [to]);
  const s = Math.max(0, Math.round(((to ? new Date(to).getTime() : now) - new Date(from).getTime()) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

type Props = { dep: Deployment; onShowOnMap: (id: string) => void; onDismiss: () => void };

export function DeploymentPanel({ dep, onShowOnMap, onDismiss }: Props) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<'machines' | 'steps' | 'log'>('machines');
  const action = useDeploymentAction();
  const elapsed = useElapsed(dep.createdAt, dep.finishedAt);
  const running = dep.status === 'running' || dep.status === 'destroying';
  const finished = !running;
  const up = dep.machines.filter((m) => m.status === 'ready' || m.status === 'warning').length;
  const tone =
    dep.status === 'succeeded' ? 'text-emerald-300' : dep.status === 'warning' ? 'text-amber-300' : dep.status === 'failed' ? 'text-rose-300' : running ? 'text-sky-300' : 'text-zinc-400';
  const act = (a: 'cancel' | 'destroy') => action.mutate({ id: dep.id, action: a }, { onError: (e) => toast.error(e.message) });

  return (
    <div className="absolute inset-x-3 bottom-3 z-20 flex max-h-[46%] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/95 shadow-2xl shadow-black/60 backdrop-blur">
      <header className="flex items-center gap-3 border-b border-zinc-800/80 px-4 py-2.5">
        {running ? <LoaderCircle className="h-4 w-4 animate-spin text-sky-300" /> : <span className={clsx('h-2 w-2 rounded-full', dep.status === 'succeeded' ? 'bg-emerald-400' : dep.status === 'failed' ? 'bg-rose-400' : 'bg-amber-400')} />}
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-zinc-100">
            {dep.labName} <span className={clsx('font-normal', tone)}>· {STATUS_TEXT[dep.status]}</span>
          </div>
          <div className="text-[11px] text-zinc-500">
            {up}/{dep.machines.length} up · {elapsed} · {dep.connName}/{dep.node}
            {dep.mock ? ' · mock' : ''}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          {dep.status === 'running' && (
            <ConfirmButton size="sm" icon={action.isPending ? LoaderCircle : Square} tone="amber" confirmLabel="Cancel deployment?" disabled={action.isPending} onConfirm={() => act('cancel')}>
              Cancel
            </ConfirmButton>
          )}
          {finished && dep.status !== 'destroyed' && dep.created.length > 0 && (
            <ConfirmButton size="sm" icon={action.isPending ? LoaderCircle : Trash2} confirmLabel={`Delete ${dep.created.length} VM(s)?`} disabled={action.isPending} onConfirm={() => act('destroy')}>
              Destroy lab
            </ConfirmButton>
          )}
          <button type="button" onClick={() => setOpen((o) => !o)} className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title={open ? 'Collapse' : 'Expand'}>
            {open ? <ChevronDown className="h-4 w-4" /> : <ChevronUp className="h-4 w-4" />}
          </button>
          {finished && (
            <button type="button" onClick={onDismiss} className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Dismiss">
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      {open && (
        <>
          <div className="flex gap-1 border-b border-zinc-800/80 px-3 pt-1.5">
            {(['machines', 'steps', 'log'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={clsx('rounded-t-md px-3 py-1 text-[11px] font-medium capitalize', tab === t ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2">
            {tab === 'machines' && (
              <div className="space-y-1">
                {dep.machines.map((m) => {
                  const s = MACHINE[m.status];
                  const access = m.access[0]?.replace('<ip>', m.ip ?? '<ip>');
                  return (
                    <div key={m.id} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-zinc-900">
                      <s.icon className={clsx('h-4 w-4 shrink-0', s.cls, m.status === 'building' && 'animate-spin')} />
                      <div className="w-32 min-w-0 shrink-0">
                        <div className="truncate text-xs font-semibold text-zinc-100">{m.name}</div>
                        <div className="text-[10px] text-zinc-500">
                          {m.label} · {m.vmid}
                        </div>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className={clsx('truncate text-[11px]', m.status === 'failed' ? 'text-rose-300' : m.status === 'warning' ? 'text-amber-200/90' : 'text-zinc-400')} title={m.message}>
                          {m.message ?? s.label}
                        </div>
                        {m.total > 0 && m.status === 'building' && (
                          <div className="mt-1 h-1 max-w-56 overflow-hidden rounded-full bg-zinc-800">
                            <div className="h-full rounded-full bg-sky-400 transition-[width] duration-500" style={{ width: `${(m.done / m.total) * 100}%` }} />
                          </div>
                        )}
                      </div>
                      <span className="w-28 shrink-0 text-right font-mono text-[11px] text-zinc-300">{m.ip ?? ''}</span>
                      {access && (m.status === 'ready' || m.status === 'warning') && (
                        <button
                          type="button"
                          title={`Copy: ${access}`}
                          onClick={() => void copyText(access.split(' — ')[0]!, `Copied: ${access.split(' — ')[0]}`)}
                          className="hidden max-w-60 shrink-0 items-center gap-1 truncate rounded-md border border-zinc-800 px-2 py-0.5 font-mono text-[10px] text-zinc-400 hover:border-zinc-700 hover:text-zinc-200 lg:inline-flex"
                        >
                          <Copy className="h-3 w-3 shrink-0" /> <span className="truncate">{access}</span>
                        </button>
                      )}
                      {dep.created.some((c) => c.vmid === m.vmid) && dep.status !== 'destroyed' && (
                        <button type="button" title="Show on the map" onClick={() => onShowOnMap(`${dep.conn}/guest:${m.vmid}`)} className="shrink-0 rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-sky-300">
                          <MapPin className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {tab === 'steps' && (
              <ol className="space-y-0.5 text-[11px]">
                {dep.steps.map((s) => {
                  const m = dep.machines.find((x) => x.id === s.machine);
                  return (
                    <li key={s.id} className="flex items-start gap-2 rounded px-2 py-0.5 hover:bg-zinc-900">
                      <span className={clsx('w-16 shrink-0 font-mono', STEP[s.status])}>{s.status}</span>
                      <span className="w-24 shrink-0 truncate text-zinc-500">{m?.name ?? 'shared'}</span>
                      <span className="shrink-0 text-zinc-200">{s.title}</span>
                      {(s.error ?? s.detail) && <span className={clsx('min-w-0 truncate', s.error ? 'text-rose-300' : 'text-zinc-500')} title={s.error ?? s.detail}>— {s.error ?? s.detail}</span>}
                      {s.progress !== undefined && <span className="ml-auto shrink-0 tabular-nums text-sky-300">{Math.round(s.progress * 100)}%</span>}
                    </li>
                  );
                })}
              </ol>
            )}
            {tab === 'log' && (
              <ol className="space-y-0.5 font-mono text-[10.5px]">
                {[...dep.log].reverse().map((l, i) => (
                  <li key={i} className={clsx('flex gap-2 px-2', l.level === 'error' ? 'text-rose-300' : l.level === 'warn' ? 'text-amber-200/90' : 'text-zinc-400')}>
                    <span className="shrink-0 text-zinc-600">{new Date(l.t).toLocaleTimeString()}</span>
                    <span>{l.msg}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </>
      )}
    </div>
  );
}
