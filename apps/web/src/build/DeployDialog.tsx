import clsx from 'clsx';
import { CheckCircle2, Download, LoaderCircle, PackageOpen, Recycle, Rocket, Upload, Wrench, X } from 'lucide-react';
import { useEffect } from 'react';
import { toast } from 'sonner';
import type { Deployment, LabPlan, LabSpec, PlannedAsset } from '@proxflow/shared';
import { ActionButton } from '../components/ConfirmButton';
import { ApiError, useDeploy, useFix, usePlan } from './api';
import { Note } from './MachinePanel';

type Props = { open: boolean; spec: LabSpec; onClose: () => void; onDeployed: (d: Deployment) => void };

const ASSET_ICON: Record<PlannedAsset['action'], typeof Download> = { reuse: Recycle, download: Download, upload: Upload };

export function DeployDialog({ open, spec, onClose, onDeployed }: Props) {
  const plan = usePlan();
  const deploy = useDeploy();
  const fix = useFix();

  // Plan as soon as the dialog opens (and again after a fix). A rejected deploy carries its own plan,
  // which would otherwise keep hiding every fresher one.
  const replan = () => {
    deploy.reset();
    plan.mutate(spec);
  };
  useEffect(() => {
    if (open) replan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const rejected = deploy.error instanceof ApiError ? deploy.error.plan : undefined;
  const p: LabPlan | undefined = rejected ?? plan.data;
  const errors = p?.issues.filter((i) => i.level === 'error') ?? [];
  const warnings = p?.issues.filter((i) => i.level === 'warning') ?? [];
  const nameOf = (id?: string) => spec.machines.find((m) => m.id === id)?.name;

  const runDeploy = () =>
    deploy.mutate(spec, {
      onSuccess: (d) => {
        toast.success(`Deploying ${spec.name}`);
        onDeployed(d);
      },
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()} className="flex max-h-[calc(100vh-2rem)] w-[min(920px,100%)] flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/70">
        <header className="flex items-start gap-3 border-b border-zinc-800 px-5 py-4">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-300">
            <Rocket className="h-4.5 w-4.5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-zinc-100">Review &amp; deploy “{spec.name}”</h2>
            <p className="text-xs text-zinc-500">
              {spec.machines.length} machine{spec.machines.length === 1 ? '' : 's'} → {spec.target.node} · disks on {spec.target.diskStorage} · network {spec.target.bridge}
            </p>
          </div>
          <button type="button" onClick={onClose} className="ml-auto rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Close (Esc)">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
          {plan.isPending && (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <LoaderCircle className="h-4 w-4 animate-spin" /> Checking the plan against {spec.target.node}…
            </div>
          )}
          {plan.isError && !p && <Note tone="error">{plan.error.message}</Note>}
          {deploy.isError && !rejected && <Note tone="error">{deploy.error.message}</Note>}

          {p && (
            <>
              {errors.length === 0 ? (
                <div className="flex items-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 text-sm text-emerald-200">
                  <CheckCircle2 className="h-4 w-4" />
                  Ready to deploy — {p.estimateMinutes <= 2 ? 'a couple of minutes' : `about ${p.estimateMinutes} min`} on real hardware
                  {p.mock ? '; the mock finishes in about a minute' : ''}.
                </div>
              ) : (
                <div className="space-y-1.5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-rose-300">Fix these first</h3>
                  {errors.map((i, n) => (
                    <div key={n} className="flex items-start gap-2">
                      <div className="flex-1">
                        <Note tone="error">
                          {nameOf(i.machine) ? <b className="mr-1">{nameOf(i.machine)}:</b> : null}
                          {i.message}
                        </Note>
                      </div>
                      {i.fix && (
                        <ActionButton
                          size="sm"
                          tone="sky"
                          icon={fix.isPending ? LoaderCircle : Wrench}
                          disabled={fix.isPending}
                          onClick={() =>
                            fix.mutate({ conn: spec.target.conn, fix: i.fix! }, { onSuccess: replan, onError: (e) => toast.error(e.message) })
                          }
                        >
                          {i.fix.label}
                        </ActionButton>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <section>
                <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Machines</h3>
                <div className="overflow-hidden rounded-xl border border-zinc-800">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-zinc-900 text-[10px] uppercase tracking-wider text-zinc-500">
                      <tr>
                        <th className="px-3 py-2 font-medium">Name</th>
                        <th className="px-3 py-2 font-medium">VMID</th>
                        <th className="px-3 py-2 font-medium">What</th>
                        <th className="px-3 py-2 font-medium">Address</th>
                        <th className="px-3 py-2 font-medium">ProxFlow knows it's ready by</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/80">
                      {p.machines.map((m) => (
                        <tr key={m.id} className="align-top">
                          <td className="px-3 py-2 font-medium text-zinc-100">{m.name}</td>
                          <td className="px-3 py-2 font-mono text-zinc-400">{m.vmid}</td>
                          <td className="px-3 py-2 text-zinc-300">
                            {m.label}
                            {m.summary && <div className="text-[10px] text-zinc-500">{m.summary}</div>}
                          </td>
                          <td className="px-3 py-2 font-mono text-zinc-300">{m.ip ?? <span className="text-zinc-500">DHCP</span>}</td>
                          <td className="px-3 py-2 text-[11px] text-zinc-400">{m.readiness || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {p.assets.length > 0 && (
                <section>
                  <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                    <PackageOpen className="h-3.5 w-3.5" /> From storage
                  </h3>
                  <ul className="space-y-1">
                    {p.assets.map((a) => {
                      const Icon = ASSET_ICON[a.action];
                      return (
                        <li key={a.id} className="flex items-start gap-2 text-xs">
                          <Icon className={clsx('mt-0.5 h-3.5 w-3.5 shrink-0', a.action === 'download' ? 'text-amber-300' : a.action === 'upload' ? 'text-zinc-500' : 'text-emerald-300')} />
                          <span className="min-w-0">
                            <span className="text-zinc-200">{a.label}</span>
                            {a.detail && <span className="text-zinc-500"> — {a.detail}</span>}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              {warnings.length > 0 && (
                <section className="space-y-1.5">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wider text-amber-300/80">Good to know</h3>
                  {warnings.map((i, n) => (
                    <Note key={n} tone="warn">
                      {nameOf(i.machine) ? <b className="mr-1">{nameOf(i.machine)}:</b> : null}
                      {i.message}
                    </Note>
                  ))}
                </section>
              )}
            </>
          )}
        </div>

        <footer className="flex items-center gap-2 border-t border-zinc-800 px-5 py-3">
          <span className="text-[11px] text-zinc-500">Nothing is created until you press Deploy. A failed lab can be removed with “Destroy lab”.</span>
          <ActionButton className="ml-auto" onClick={onClose}>
            Close
          </ActionButton>
          <ActionButton tone="sky" icon={deploy.isPending ? LoaderCircle : Rocket} disabled={!p?.ok || deploy.isPending || plan.isPending} onClick={runDeploy}>
            Deploy {spec.machines.length} machine{spec.machines.length === 1 ? '' : 's'}
          </ActionButton>
        </footer>
      </div>
    </div>
  );
}
