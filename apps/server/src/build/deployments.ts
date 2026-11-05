/** Runs lab plans: a dependency-ordered, concurrency-limited step executor with persistence. */
import { randomUUID } from 'node:crypto';
import type { Deployment, DeploymentStep, LabPlan, LabSpec, StepStatus } from '@proxflow/shared';
import { readJsonFile, writeJsonFile } from '../json-file.js';
import type { PveClient } from '../pve/client.js';
import type { BoxCache } from './box-cache.js';
import type { InventoryBundle } from './inventory.js';
import { planLab } from './plan.js';
import { AbortError, abortableSleep, errMsg, waitForTask, type StepContext, type StepGroup } from './steps.js';

export class PlanRejected extends Error {
  readonly status = 400;
  constructor(readonly plan: LabPlan) {
    super('The lab plan has errors — fix them and try again.');
  }
}
export class DeploymentNotFound extends Error {
  readonly status = 404;
}
export class DeploymentConflict extends Error {
  readonly status = 409;
}

/** How many steps of each kind may run at once (restores and creates contend for storage). */
const LIMITS: Record<StepGroup, number> = { restore: 1, download: 2, upload: 3, create: 2, power: 4, wait: 1000, cleanup: 4 };
/** Against the mock, waits and timeouts are compressed so a full AD lab demo takes about a minute. */
const MOCK_SCALE = 0.05;
const MAX_KEPT = 30;
const MAX_LOG = 500;

const now = () => new Date().toISOString();
const OK: StepStatus[] = ['done', 'warning'];
const BLOCKING: StepStatus[] = ['failed', 'skipped', 'cancelled'];

export class DeploymentManager {
  private deps = new Map<string, Deployment>();
  private aborts = new Map<string, AbortController>();
  private saveTimer?: NodeJS.Timeout;

  /** `onGuestsChanged` lets the map drop its cached topology the moment guests are created or deleted. */
  constructor(
    private readonly file: string,
    private readonly onGuestsChanged: (conn: string) => void = () => {},
  ) {
    const parsed = readJsonFile<{ deployments?: Deployment[] }>(file);
    for (const d of parsed?.deployments ?? []) {
      // A restart interrupts anything that was in flight; say so instead of pretending it's still running.
      if (d.status === 'running' || d.status === 'destroying') {
        d.status = 'interrupted';
        for (const s of d.steps) if (s.status === 'running' || s.status === 'pending') s.status = 'cancelled';
        this.refreshMachines(d);
      }
      this.deps.set(d.id, d);
    }
  }

  list(): Deployment[] {
    return [...this.deps.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): Deployment {
    const d = this.deps.get(id);
    if (!d) throw new DeploymentNotFound(`No deployment "${id}"`);
    return d;
  }

  start(client: PveClient, conn: { id: string; name: string }, spec: LabSpec, bundle: InventoryBundle, boxCache: BoxCache): Deployment {
    const id = randomUUID().slice(0, 8);
    const { plan, steps } = planLab(spec, bundle, { tag: id, boxCache });
    if (!plan.ok) throw new PlanRejected(plan);
    const t = now();
    const dep: Deployment = {
      id,
      labName: spec.name,
      conn: conn.id,
      connName: conn.name,
      node: spec.target.node,
      mock: bundle.inv.mock,
      createdAt: t,
      updatedAt: t,
      status: 'running',
      machines: plan.machines.map((m) => ({ ...m, status: 'pending', done: 0, total: 0 })),
      steps: plan.steps.map((s) => ({ ...s, status: 'pending' })),
      log: [],
      created: [],
      uploaded: [],
    };
    this.refreshMachines(dep);
    this.deps.set(id, dep);
    this.log(dep, 'info', `Deploying ${dep.machines.length} machine(s) of "${spec.name}" to ${conn.name}/${dep.node}`);
    this.prune();
    this.save(true);
    void this.run(dep, steps, client);
    return dep;
  }

  cancel(id: string) {
    const dep = this.get(id);
    const ac = this.aborts.get(id);
    if (!ac) throw new DeploymentConflict('This deployment isn\'t running.');
    this.log(dep, 'warn', 'Cancelling — running steps stop at their next check');
    ac.abort();
  }

  /** Stops and deletes every guest and setup ISO this deployment created. Box templates are kept for reuse. */
  destroy(id: string, client: PveClient) {
    const dep = this.get(id);
    if (dep.status === 'running' || dep.status === 'destroying') throw new DeploymentConflict('Cancel the deployment first, then destroy it.');
    dep.status = 'destroying';
    this.touch(dep, true);
    const ctx = { client, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, dep.mock ? 200 : ms)), timeout: (ms: number) => ms };
    void (async () => {
      let problems = 0;
      for (const g of [...dep.created].reverse()) {
        try {
          const cfg = await client.guestConfig(dep.node, g.type, g.vmid).catch((e: unknown) => {
            if (/does not exist|no such/i.test(errMsg(e))) return null;
            throw e;
          });
          if (!cfg) {
            this.log(dep, 'info', `${g.name} (${g.vmid}) was already gone`);
            continue;
          }
          // VMIDs are reused once freed: only delete the guest if it is still the one this deployment made.
          const owner = [...String(cfg.description ?? '').matchAll(/\(deployment ([A-Za-z0-9-]+)\)/g)].at(-1)?.[1]; // the lab name may contain the phrase too
          const name = String((g.type === 'qemu' ? cfg.name : cfg.hostname) ?? '');
          const ours = String(cfg.template ?? '') !== '1' && (owner ? owner === dep.id : name === g.name);
          if (!ours) {
            problems++;
            this.log(dep, 'warn', `Left ${g.vmid} alone: it's now "${name || 'unnamed'}"${owner ? ` from deployment ${owner}` : ''}, not this lab's ${g.name}`);
            continue;
          }
          const st = await client.guestStatus(dep.node, g.type, g.vmid);
          if (st.status === 'running') await waitForTask(ctx, await client.guestStatusAction(dep.node, g.type, g.vmid, 'stop'), { what: `Stop ${g.name}` });
          await waitForTask(ctx, await client.destroyGuest(dep.node, g.type, g.vmid), { what: `Delete ${g.name}` });
          this.log(dep, 'info', `Deleted ${g.name} (${g.vmid})`);
        } catch (e) {
          problems++;
          this.log(dep, 'error', `Couldn't delete ${g.name} (${g.vmid}): ${errMsg(e)}`);
        }
        this.touch(dep);
      }
      for (const volid of dep.uploaded) {
        try {
          await waitForTask(ctx, await client.deleteVolume(dep.node, volid.slice(0, volid.indexOf(':')), volid), { what: `Delete ${volid}` });
          this.log(dep, 'info', `Deleted ${volid}`);
        } catch (e) {
          if (!/does not exist|no such|not found/i.test(errMsg(e))) {
            problems++;
            this.log(dep, 'warn', `Couldn't delete ${volid}: ${errMsg(e)}`);
          }
        }
      }
      dep.status = 'destroyed';
      this.log(dep, problems ? 'warn' : 'info', problems ? `Destroyed with ${problems} problem(s) — see above` : 'Lab destroyed');
      this.onGuestsChanged(dep.conn);
      this.touch(dep, true);
    })();
  }

  // ───────────────────────── execution ─────────────────────────

  private async run(dep: Deployment, defs: import('./steps.js').StepDef[], client: PveClient) {
    const ac = new AbortController();
    this.aborts.set(dep.id, ac);
    const byId = new Map(dep.steps.map((s) => [s.id, s]));
    const defById = new Map(defs.map((d) => [d.id, d]));
    const shared = new Map<string, unknown>();
    const running = new Map<string, Promise<void>>();
    const active: Partial<Record<StepGroup, number>> = {};
    const status = (id: string) => byId.get(id)?.status;
    const label = (s: DeploymentStep) => {
      const m = dep.machines.find((x) => x.id === s.machine);
      return m ? `${m.name}: ${s.title}` : s.title;
    };

    const ctxFor = (s: DeploymentStep): StepContext => ({
      client,
      node: dep.node,
      mock: dep.mock,
      signal: ac.signal,
      detail: (t) => {
        s.detail = t;
        this.touch(dep);
      },
      progress: (p) => {
        s.progress = p;
        this.touch(dep);
      },
      sleep: (ms) => abortableSleep(dep.mock ? Math.max(150, ms * MOCK_SCALE) : ms, ac.signal),
      timeout: (ms) => (dep.mock ? Math.max(30_000, ms * MOCK_SCALE) : ms),
      stepStatus: status,
      setMachine: (id, patch) => {
        const m = dep.machines.find((x) => x.id === id);
        if (m) Object.assign(m, patch);
        this.touch(dep);
      },
      shared,
      recordCreated: (vmid, type, name) => {
        if (!dep.created.some((c) => c.vmid === vmid)) dep.created.push({ vmid, type, name });
        this.onGuestsChanged(dep.conn);
        this.touch(dep, true);
      },
      recordUpload: (volid) => {
        if (!dep.uploaded.includes(volid)) dep.uploaded.push(volid);
        this.touch(dep, true);
      },
      log: (level, msg) => this.log(dep, level, msg),
    });

    const launch = (s: DeploymentStep) => {
      const def = defById.get(s.id)!;
      s.status = 'running';
      s.startedAt = now();
      active[def.group] = (active[def.group] ?? 0) + 1;
      const p = (async () => {
        try {
          const out = await def.run(ctxFor(s));
          if (out && out.warning) {
            s.status = 'warning';
            s.detail = out.warning;
            this.log(dep, 'warn', `${label(s)} — ${out.warning}`);
          } else {
            s.status = 'done';
            if (out && out.detail) s.detail = out.detail;
          }
        } catch (e) {
          if (ac.signal.aborted || e instanceof AbortError) {
            s.status = 'cancelled';
            s.detail = 'Cancelled';
          } else {
            s.status = 'failed';
            s.error = errMsg(e);
            this.log(dep, 'error', `${label(s)} failed: ${s.error}`);
          }
        } finally {
          s.progress = undefined;
          s.endedAt = now();
          active[def.group] = (active[def.group] ?? 1) - 1;
          running.delete(s.id);
          this.refreshMachines(dep);
          this.touch(dep);
        }
      })();
      running.set(s.id, p);
    };

    try {
      for (;;) {
        for (let changed = true; changed; ) {
          changed = false;
          for (const s of dep.steps) {
            if (s.status === 'pending' && s.deps.some((d) => BLOCKING.includes(status(d) ?? 'pending'))) {
              s.status = 'skipped';
              s.detail = 'Skipped — something it depends on failed';
              changed = true;
            }
          }
        }
        if (ac.signal.aborted) break;
        for (const s of dep.steps) {
          if (s.status !== 'pending' || !s.deps.every((d) => OK.includes(status(d) ?? 'pending'))) continue;
          const g = defById.get(s.id)!.group;
          if ((active[g] ?? 0) >= LIMITS[g]) continue;
          launch(s);
        }
        this.refreshMachines(dep);
        this.touch(dep);
        if (running.size === 0) break;
        await Promise.race(running.values());
      }
      await Promise.allSettled([...running.values()]);
    } finally {
      for (const s of dep.steps) if (s.status === 'pending' || s.status === 'running') s.status = ac.signal.aborted ? 'cancelled' : 'skipped';
      const all = dep.steps.map((s) => s.status);
      dep.status = ac.signal.aborted ? 'cancelled' : all.includes('failed') || all.includes('skipped') ? 'failed' : all.includes('warning') ? 'warning' : 'succeeded';
      dep.finishedAt = now();
      this.refreshMachines(dep);
      const ready = dep.machines.filter((m) => m.status === 'ready' || m.status === 'warning').length;
      this.log(dep, dep.status === 'succeeded' ? 'info' : 'warn', `Finished: ${ready}/${dep.machines.length} machine(s) up — ${dep.status}`);
      this.onGuestsChanged(dep.conn);
      this.aborts.delete(dep.id);
      this.touch(dep, true);
    }
  }

  private refreshMachines(dep: Deployment) {
    for (const m of dep.machines) {
      const ss = dep.steps.filter((s) => s.machine === m.id);
      m.total = ss.length;
      m.done = ss.filter((s) => OK.includes(s.status)).length;
      const failed = ss.find((s) => s.status === 'failed');
      const skipped = ss.find((s) => s.status === 'skipped');
      const running = ss.find((s) => s.status === 'running');
      const warn = ss.find((s) => s.status === 'warning');
      if (failed) {
        m.status = 'failed';
        m.message = `${failed.title}: ${failed.error}`;
      } else if (skipped) {
        const blocker = dep.steps.find((s) => s.status === 'failed' && (skipped.deps.includes(s.id) || !s.machine));
        m.status = ss.some((s) => s.status === 'cancelled') ? 'cancelled' : 'failed';
        m.message = blocker ? `Blocked: ${blocker.title} failed` : 'Blocked by an earlier failure';
      } else if (ss.some((s) => s.status === 'cancelled')) {
        m.status = 'cancelled';
        m.message = 'Cancelled';
      } else if (ss.length && ss.every((s) => OK.includes(s.status))) {
        m.status = warn ? 'warning' : 'ready';
        m.message = warn?.detail ?? ss.find((s) => s.id.endsWith(':ready'))?.detail;
      } else if (running || ss.some((s) => s.status !== 'pending')) {
        m.status = 'building';
        m.message = running ? `${running.title}${running.detail ? ` — ${running.detail}` : ''}` : undefined;
      } else {
        m.status = 'pending';
        m.message = undefined;
      }
    }
  }

  private log(dep: Deployment, level: 'info' | 'warn' | 'error', msg: string) {
    dep.log.push({ t: now(), level, msg });
    if (dep.log.length > MAX_LOG) dep.log.splice(0, dep.log.length - MAX_LOG);
    this.touch(dep);
  }

  private prune() {
    const all = this.list();
    for (const d of all.slice(MAX_KEPT)) if (d.status !== 'running' && d.status !== 'destroying') this.deps.delete(d.id);
  }

  private touch(dep: Deployment, immediate = false) {
    dep.updatedAt = now();
    if (immediate) return this.save(true);
    this.saveTimer ??= setTimeout(() => this.save(true), 1000);
  }

  private save(force = false) {
    if (!force) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    try {
      writeJsonFile(this.file, { version: 1, deployments: this.list() });
    } catch (err) {
      console.error('[server] could not save deployments:', errMsg(err));
    }
  }
}
