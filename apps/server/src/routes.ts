import { Router, type Request } from 'express';
import { GUEST_ACTIONS, type AuthInput, type ConnectionInput, type GuestAction, type GuestType, type HealthInfo, type TlsConfig } from '@proxflow/shared';
import type { ConnectionManager } from './connections/manager.js';
import { operations } from './pve/operations.js';
import { probeConnection } from './pve/probe.js';

import { HttpError } from './errors.js';

export { HttpError };

const param = (req: Request, name: string) => String((req.params as Record<string, string>)[name] ?? '');

function guestParams(req: Request): { conn: string; node: string; type: GuestType; vmid: number } {
  const conn = param(req, 'conn');
  const node = param(req, 'node');
  const type = param(req, 'type');
  const vmid = Number(param(req, 'vmid'));
  if (!/^[a-z0-9.-]+$/i.test(node)) throw new HttpError(400, `invalid node '${node}'`);
  if (type !== 'qemu' && type !== 'lxc') throw new HttpError(400, `guest type must be qemu or lxc, got '${type}'`);
  if (!Number.isInteger(vmid) || vmid < 100) throw new HttpError(400, `invalid vmid '${param(req, 'vmid')}'`);
  return { conn, node, type, vmid };
}

const SNAPSHOT_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const snapshotName = (raw: unknown) => {
  const name = String(raw ?? '').trim();
  if (!SNAPSHOT_NAME.test(name)) {
    throw new HttpError(400, 'snapshot name must start with a letter and contain only letters, digits, "_" or "-"');
  }
  return name;
};

const TOKEN_ID = /^[^\s!@]+@[^\s!@]+![^\s!@]+$/;
const TLS_MODES = new Set(['system', 'pinned', 'insecure']);

/** Validates the JSON body for create/update/test. `requireSecrets` is false for updates (blank = keep). */
function parseConnectionInput(body: unknown, { requireSecrets }: { requireSecrets: boolean }): ConnectionInput {
  const b = (body ?? {}) as Record<string, unknown>;
  const url = typeof b.url === 'string' ? b.url.trim() : '';
  if (!url) throw new HttpError(400, 'Host URL is required');

  const a = (b.auth ?? {}) as Record<string, unknown>;
  let auth: AuthInput;
  if (a.type === 'token') {
    const tokenId = String(a.tokenId ?? '').trim();
    const secret = String(a.secret ?? '').trim();
    if (!TOKEN_ID.test(tokenId)) throw new HttpError(400, 'Token ID must look like user@realm!tokenname, e.g. root@pam!proxflow');
    if (requireSecrets && !secret) throw new HttpError(400, 'Token secret is required');
    auth = { type: 'token', tokenId, secret };
  } else if (a.type === 'password') {
    const username = String(a.username ?? '').trim();
    const password = String(a.password ?? '');
    if (!username) throw new HttpError(400, 'Username is required (e.g. root@pam)');
    if (requireSecrets && !password) throw new HttpError(400, 'Password is required');
    auth = { type: 'password', username, password };
  } else {
    throw new HttpError(400, 'auth.type must be "token" or "password"');
  }

  let tls: TlsConfig | undefined;
  if (b.tls !== undefined) {
    const t = (b.tls ?? {}) as Record<string, unknown>;
    const mode = String(t.mode ?? 'system');
    if (!TLS_MODES.has(mode)) throw new HttpError(400, 'tls.mode must be system, pinned or insecure');
    const fingerprint = typeof t.fingerprint === 'string' ? t.fingerprint.trim() : undefined;
    if (mode === 'pinned' && !fingerprint) throw new HttpError(400, 'A certificate fingerprint is required to pin');
    tls = { mode: mode as TlsConfig['mode'], fingerprint: mode === 'pinned' ? fingerprint : undefined };
  }

  const name = typeof b.name === 'string' ? b.name.trim().slice(0, 64) : undefined;
  const enabled = typeof b.enabled === 'boolean' ? b.enabled : undefined;
  return { name, url, auth, tls, enabled };
}

export function createRoutes(manager: ConnectionManager) {
  const r = Router();

  r.get('/health', (_req, res) => {
    const list = manager.list();
    const info: HealthInfo = { ok: true, connections: list.length, connected: list.filter((c) => c.status?.ok).length };
    res.json(info);
  });

  // ───── connections ─────

  r.get('/connections', (_req, res) => {
    res.json(manager.list());
  });

  r.post('/connections/test', async (req, res) => {
    const input = parseConnectionInput(req.body, { requireSecrets: true });
    res.json(await probeConnection(input));
  });

  r.post('/connections', async (req, res) => {
    const input = parseConnectionInput(req.body, { requireSecrets: true });
    const created = manager.add(input);
    res.status(201).json(created);
  });

  r.post('/connections/:id/test', async (req, res) => {
    const id = param(req, 'id');
    const hasBody = req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0;
    const overrides = hasBody ? parseConnectionInput(req.body, { requireSecrets: false }) : undefined;
    res.json(await manager.probe(id, overrides));
  });

  r.put('/connections/:id', (req, res) => {
    const id = param(req, 'id');
    const input = parseConnectionInput(req.body, { requireSecrets: false });
    res.json(manager.update(id, input));
  });

  r.delete('/connections/:id', (req, res) => {
    manager.remove(param(req, 'id'));
    res.json({ ok: true });
  });

  // ───── topology & guests ─────

  r.get('/topology', async (_req, res) => {
    res.json(await manager.topology());
  });

  r.get('/tasks/:conn/:node/:upid', async (req, res) => {
    const client = manager.client(param(req, 'conn'));
    const node = param(req, 'node');
    const upid = param(req, 'upid');
    if (!upid.startsWith('UPID:')) throw new HttpError(400, 'invalid UPID');
    const wait = Math.min(Math.max(Number(req.query.wait ?? 0) || 0, 0), 30_000);
    const task = await operations.waitForTask(client, node, upid, { timeoutMs: wait });
    if (task.status === 'stopped') manager.invalidate(param(req, 'conn'));
    res.json(task);
  });

  // Snapshot routes must be registered before the generic `/:action` route below,
  // otherwise "snapshots" is captured as an action name.
  r.get('/guests/:conn/:node/:type/:vmid/snapshots', async (req, res) => {
    const { conn, node, type, vmid } = guestParams(req);
    res.json(await operations.listSnapshots(manager.client(conn), node, type, vmid));
  });

  r.post('/guests/:conn/:node/:type/:vmid/snapshots', async (req, res) => {
    const { conn, node, type, vmid } = guestParams(req);
    const body = (req.body ?? {}) as { name?: string; description?: string; vmstate?: boolean };
    const name = snapshotName(body.name);
    const upid = await operations.createSnapshot(manager.client(conn), node, type, vmid, name, body.description, body.vmstate);
    res.json({ upid });
  });

  r.delete('/guests/:conn/:node/:type/:vmid/snapshots/:name', async (req, res) => {
    const { conn, node, type, vmid } = guestParams(req);
    const upid = await operations.deleteSnapshot(manager.client(conn), node, type, vmid, snapshotName(param(req, 'name')));
    res.json({ upid });
  });

  r.post('/guests/:conn/:node/:type/:vmid/:action', async (req, res) => {
    const { conn, node, type, vmid } = guestParams(req);
    const action = param(req, 'action') as GuestAction;
    if (!GUEST_ACTIONS.includes(action)) throw new HttpError(400, `unknown action '${action}'`);
    const upid = await operations.guestAction(manager.client(conn), node, type, vmid, action);
    manager.invalidate(conn);
    res.json({ upid });
  });

  return r;
}
