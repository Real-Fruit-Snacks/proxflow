import { Router, type Request } from 'express';
import type { LabSpec } from '@proxflow/shared';
import type { ConnectionManager } from '../connections/manager.js';
import { HttpError } from '../errors.js';
import type { BoxCache } from './box-cache.js';
import { PlanRejected, type DeploymentManager } from './deployments.js';
import { getInventory } from './inventory.js';
import { planLab } from './plan.js';

const param = (req: Request, name: string) => String((req.params as Record<string, string>)[name] ?? '');
const CONTENT_TYPES = new Set(['import', 'iso', 'vztmpl', 'images', 'rootdir', 'backup', 'snippets']);
const MAX_MACHINES = 50;

/** Structural checks only — semantic validation is validateLab(), shared with the UI. */
function parseSpec(body: unknown): LabSpec {
  const b = (body ?? {}) as Partial<LabSpec>;
  const t = (b.target ?? {}) as Partial<LabSpec['target']>;
  const d = (b.defaults ?? {}) as Partial<LabSpec['defaults']>;
  if (!Array.isArray(b.machines)) throw new HttpError(400, 'spec.machines must be an array');
  if (b.machines.length > MAX_MACHINES) throw new HttpError(400, `A lab can have at most ${MAX_MACHINES} machines`);
  for (const m of b.machines) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.name !== 'string' || !m.net || typeof m.net !== 'object')
      throw new HttpError(400, 'Every machine needs an id, a name and a net section');
    if (!['linux-vm', 'lxc', 'windows', 'esxi'].includes(m.kind)) throw new HttpError(400, `Unknown machine kind "${String((m as { kind?: unknown }).kind)}"`);
    if (m.kind !== 'esxi' && (!('source' in m) || !m.source || typeof m.source !== 'object')) throw new HttpError(400, `Machine ${m.name} has no source`);
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    name: str(b.name).slice(0, 60),
    target: {
      conn: str(t.conn),
      node: str(t.node),
      diskStorage: str(t.diskStorage),
      isoStorage: str(t.isoStorage),
      importStorage: str(t.importStorage),
      bridge: str(t.bridge),
    },
    defaults: { username: str(d.username), password: str(d.password), sshKey: str(d.sshKey), dns: str(d.dns) },
    machines: b.machines,
  };
}

export function createBuildRoutes(manager: ConnectionManager, deployments: DeploymentManager, boxCache: BoxCache) {
  const r = Router();

  const inventory = async (conn: string, node?: string) => {
    if (!conn) throw new HttpError(400, 'Choose a connection first');
    const client = manager.client(conn);
    const topo = await manager.clusterTopology(conn).catch(() => undefined);
    return getInventory(client, { id: conn }, node || undefined, topo);
  };

  r.get('/connections/:id/inventory', async (req, res) => {
    const node = typeof req.query.node === 'string' ? req.query.node : undefined;
    res.json((await inventory(param(req, 'id'), node)).inv);
  });

  r.post('/labs/plan', async (req, res) => {
    const spec = parseSpec(req.body);
    const bundle = await inventory(spec.target.conn, spec.target.node);
    res.json(planLab(spec, bundle, { tag: 'preview', boxCache }).plan);
  });

  /** One-click fixes offered by the plan, e.g. enabling "Import" content on a storage. */
  r.post('/labs/fix', async (req, res) => {
    const b = (req.body ?? {}) as { conn?: string; fix?: { kind?: string; storage?: string; content?: string } };
    const fix = b.fix ?? {};
    if (fix.kind !== 'enable-content' || !fix.storage || !fix.content || !CONTENT_TYPES.has(fix.content)) throw new HttpError(400, 'Unsupported fix');
    const client = manager.client(String(b.conn ?? ''));
    const cfg = await client.storageConfig(fix.storage);
    const content = new Set((cfg.content ?? '').split(',').filter(Boolean));
    content.add(fix.content);
    await client.updateStorage(fix.storage, { content: [...content].join(',') });
    res.json({ ok: true, content: [...content] });
  });

  r.post('/labs/deploy', async (req, res) => {
    const spec = parseSpec(req.body);
    const bundle = await inventory(spec.target.conn, spec.target.node);
    try {
      const dep = deployments.start(manager.client(spec.target.conn), manager.info(spec.target.conn), spec, bundle, boxCache);
      res.status(201).json(dep);
    } catch (e) {
      if (e instanceof PlanRejected) {
        res.status(400).json({ error: e.message, status: 400, plan: e.plan });
        return;
      }
      throw e;
    }
  });

  r.get('/labs/deployments', (_req, res) => {
    res.json(deployments.list());
  });

  r.get('/labs/deployments/:id', (req, res) => {
    res.json(deployments.get(param(req, 'id')));
  });

  r.post('/labs/deployments/:id/cancel', (req, res) => {
    deployments.cancel(param(req, 'id'));
    res.json(deployments.get(param(req, 'id')));
  });

  r.post('/labs/deployments/:id/destroy', (req, res) => {
    const dep = deployments.get(param(req, 'id'));
    deployments.destroy(dep.id, manager.client(dep.conn));
    res.json(deployments.get(dep.id));
  });

  return r;
}
