/**
 * Proxmox VE API lookalike. Only the endpoints ProxFlow uses are implemented,
 * but response shapes follow the real /api2/json contract so the real client
 * code path is exercised against this mock.
 */
import { Router, type Request, type Response } from 'express';
import { initSim, mockStatusExtras, registerLabRoutes } from './lab-routes.js';
import {
  CLUSTER_NAME,
  GiB,
  MiB,
  bridges,
  guests,
  nodes,
  runTask,
  storages,
  tasks,
  type GuestType,
  type MockGuest,
  type MockSnapshot,
} from './state.js';

const ok = (res: Response, data: unknown) => res.json({ data });
const fail = (res: Response, status: number, message: string) =>
  res.status(status).json({ data: null, message, errors: { message } });

const secs = () => Math.floor(Date.now() / 1000);
const uptimeOf = (since: number | null) => (since ? Math.floor((Date.now() - since) / 1000) : 0);
const param = (req: Request, name: string) => String((req.params as Record<string, string>)[name] ?? '');

// ───── resource shapes ─────

function nodeResource(n: (typeof nodes)[number]) {
  return {
    id: `node/${n.name}`,
    type: 'node',
    node: n.name,
    status: n.status,
    cpu: n.cpu,
    maxcpu: n.maxcpu,
    mem: n.mem,
    maxmem: n.maxmem,
    disk: n.disk,
    maxdisk: n.maxdisk,
    uptime: uptimeOf(n.bootedAt),
    level: '',
  };
}

function guestResource(g: MockGuest) {
  const running = g.status === 'running';
  const uptime = running ? uptimeOf(g.startedAt) : 0;
  return {
    id: `${g.type}/${g.vmid}`,
    type: g.type,
    vmid: g.vmid,
    name: g.name,
    node: g.node,
    status: g.status,
    template: g.template ? 1 : 0,
    cpu: running ? g.cpu : 0,
    maxcpu: g.cores,
    mem: running ? Math.round(g.mem) : 0,
    maxmem: g.memoryMiB * MiB,
    disk: 0,
    maxdisk: g.maxdisk,
    uptime,
    netin: running ? uptime * 12_000 : 0,
    netout: running ? uptime * 4_000 : 0,
    diskread: running ? uptime * 50_000 : 0,
    diskwrite: running ? uptime * 20_000 : 0,
    ...(g.tags.length ? { tags: g.tags.join(';') } : {}),
  };
}

function storageResources() {
  return storages.flatMap((s) =>
    s.nodes.map((node) => ({
      id: `storage/${node}/${s.name}`,
      type: 'storage',
      storage: s.name,
      node,
      status: 'available',
      shared: s.shared ? 1 : 0,
      content: s.content.join(','),
      plugintype: s.type,
      disk: Math.round(s.used),
      maxdisk: Math.round(s.total),
    })),
  );
}

function guestConfig(g: MockGuest) {
  const base =
    g.type === 'qemu'
      ? {
          name: g.name,
          cores: g.cores,
          sockets: 1,
          cpu: 'x86-64-v2-AES',
          memory: g.memoryMiB,
          ostype: g.ostype,
          boot: 'order=scsi0;net0',
          scsihw: 'virtio-scsi-single',
          numa: 0,
          smbios1: `uuid=7a1c0b0e-0000-4000-8000-${String(g.vmid).padStart(12, '0')}`,
          vmgenid: `0b4f5c1a-0000-4000-8000-${String(g.vmid).padStart(12, '0')}`,
        }
      : {
          hostname: g.name,
          cores: g.cores,
          memory: g.memoryMiB,
          swap: 512,
          ostype: g.ostype,
          arch: 'amd64',
          unprivileged: 1,
          features: 'nesting=1',
        };
  return {
    ...base,
    ...g.config,
    ...(g.tags.length ? { tags: g.tags.join(';') } : {}),
    ...(g.template ? { template: 1 } : {}),
    digest: 'f1d2d2f924e986ac86fdf7b36c94bcdf32beec15',
  };
}

function findGuest(req: Request, res: Response): MockGuest | null {
  const node = param(req, 'node');
  const type = param(req, 'type');
  const vmid = Number(param(req, 'vmid'));
  if (type !== 'qemu' && type !== 'lxc') {
    fail(res, 501, `Method '${req.method} ${req.path}' not implemented`);
    return null;
  }
  const g = guests.find((x) => x.vmid === vmid && x.type === type);
  if (!g || g.node !== node) {
    const dir = type === 'qemu' ? 'qemu-server' : 'lxc';
    fail(res, 500, `Configuration file 'nodes/${node}/${dir}/${vmid}.conf' does not exist`);
    return null;
  }
  return g;
}

const taskPrefix = (t: GuestType) => (t === 'qemu' ? 'qm' : 'vz');
const label = (t: GuestType) => (t === 'qemu' ? 'VM' : 'CT');

// ───── router ─────

export const router = Router();

// ───── auth ─────
// Tokens:   any "user@realm!name" with secret "mock-secret" (full admin) or "readonly" (PVEAuditor-like).
// Password: any "user@realm" with password "mock".
const TOKEN_ID = /^PVEAPIToken=([^\s!@=]+@[^\s!@=]+![^\s=]+)=(.+)$/;
const CSRF = 'mock-csrf-token:0000';
const tickets = new Map<string, { user: string; issued: number }>();

router.post('/access/ticket', (req, res) => {
  const body = (req.body ?? {}) as Record<string, string>;
  const user = String(body.username ?? '');
  if (!user.includes('@') || String(body.password ?? '') !== 'mock') return fail(res, 401, 'authentication failure');
  const ticket = `PVE:${user}:${Date.now().toString(16).toUpperCase()}::mock-signature`;
  tickets.set(ticket, { user, issued: Date.now() });
  ok(res, { ticket, CSRFPreventionToken: CSRF, username: user, cap: {} });
});

router.use((req, res, next) => {
  const auth = req.header('authorization') ?? '';
  const m = TOKEN_ID.exec(auth);
  if (m) {
    if (m[2] !== 'mock-secret' && m[2] !== 'readonly') return fail(res, 401, 'authentication failure (invalid token secret)');
    res.locals.identity = { user: m[1], readonly: m[2] === 'readonly' };
    return next();
  }
  if (auth) return fail(res, 401, 'authentication failure (malformed PVEAPIToken header)');
  const cookie = /PVEAuthCookie=([^;]+)/.exec(req.header('cookie') ?? '');
  const ticket = cookie ? tickets.get(decodeURIComponent(cookie[1]!)) : undefined;
  if (ticket) {
    if (Date.now() - ticket.issued > 2 * 3600_000) return fail(res, 401, 'ticket expired');
    if (req.method !== 'GET' && req.header('csrfpreventiontoken') !== CSRF) return fail(res, 401, 'Permission denied - invalid csrf token');
    res.locals.identity = { user: ticket.user, readonly: false };
    return next();
  }
  fail(res, 401, 'authentication failure (no ticket or API token)');
});

const ALL_PRIVS = [
  'VM.Audit', 'VM.PowerMgmt', 'VM.Snapshot', 'VM.Snapshot.Rollback', 'VM.Clone', 'VM.Allocate', 'VM.Migrate', 'VM.Backup',
  'VM.Console', 'VM.Monitor', 'VM.Config.CPU', 'VM.Config.Memory', 'VM.Config.Disk', 'VM.Config.Network', 'VM.Config.Options',
  'VM.Config.CDROM', 'VM.Config.HWType', 'VM.Config.Cloudinit',
  'Sys.Audit', 'Sys.Modify', 'Sys.PowerMgmt', 'Sys.Console', 'Sys.Syslog', 'Sys.AccessNetwork', 'SDN.Use', 'SDN.Audit',
  'Datastore.Audit', 'Datastore.Allocate', 'Datastore.AllocateSpace', 'Datastore.AllocateTemplate',
  'Permissions.Modify', 'Pool.Audit', 'Pool.Allocate', 'Realm.Allocate', 'SDN.Audit', 'SDN.Allocate', 'User.Modify', 'Group.Allocate',
];
const AUDIT_PRIVS = ['VM.Audit', 'Sys.Audit', 'Datastore.Audit', 'Pool.Audit', 'SDN.Audit'];

router.get('/access/permissions', (_req, res) => {
  const readonly = Boolean((res.locals.identity as { readonly?: boolean } | undefined)?.readonly);
  const privs = Object.fromEntries((readonly ? AUDIT_PRIVS : ALL_PRIVS).map((p) => [p, 1]));
  ok(res, { '/': privs });
});

router.get('/version', (_req, res) => {
  ok(res, { version: '8.4.1', release: '8.4', repoid: 'mock0000', console: 'xtermjs' });
});

router.get('/cluster/status', (_req, res) => {
  ok(res, [
    { type: 'cluster', id: 'cluster', name: CLUSTER_NAME, version: 2, quorate: 1, nodes: nodes.length },
    ...nodes.map((n, i) => ({
      type: 'node',
      id: `node/${n.name}`,
      name: n.name,
      nodeid: n.nodeid,
      ip: n.ip,
      online: n.status === 'online' ? 1 : 0,
      local: i === 0 ? 1 : 0,
      level: '',
    })),
  ]);
});

router.get('/cluster/resources', (req, res) => {
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const all = [...nodes.map(nodeResource), ...guests.map(guestResource), ...storageResources()];
  const filtered = !type
    ? all
    : all.filter((r) => (type === 'vm' ? r.type === 'qemu' || r.type === 'lxc' : r.type === type));
  ok(res, filtered);
});

router.get('/nodes', (_req, res) => {
  ok(
    res,
    nodes.map((n) => ({
      ...nodeResource(n),
      ssl_fingerprint: 'AB:CD:EF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC',
    })),
  );
});

router.get('/nodes/:node/network', (req, res) => {
  const node = param(req, 'node');
  if (!nodes.some((n) => n.name === node)) return fail(res, 500, `hostname lookup '${node}' failed - failed to get address info`);
  const type = typeof req.query.type === 'string' ? req.query.type : undefined;
  const mine = bridges.filter((b) => b.node === node);
  const ifaces: Record<string, unknown>[] = [
    { iface: 'lo', type: 'loopback', method: 'loopback', active: 1, autostart: 1, families: ['inet', 'inet6'], priority: 1 },
    { iface: 'eno1', type: 'eth', method: 'manual', active: 1, exists: 1, autostart: 1, families: ['inet'], priority: 2 },
    ...mine.map((b, i) => ({
      iface: b.iface,
      type: 'bridge',
      method: b.cidr ? 'static' : 'manual',
      cidr: b.cidr,
      address: b.address,
      netmask: b.cidr ? b.cidr.split('/')[1] : undefined,
      gateway: b.gateway,
      bridge_ports: b.ports.join(' ') || 'none',
      bridge_stp: 'off',
      bridge_fd: '0',
      bridge_vlan_aware: b.vlanAware ? 1 : 0,
      active: 1,
      autostart: 1,
      families: ['inet'],
      priority: 3 + i,
    })),
  ];
  ok(res, type ? ifaces.filter((i) => i.type === type) : ifaces);
});

// Tasks (declared before the generic guest routes so `tasks` isn't captured as a guest type)
router.get('/nodes/:node/tasks', (req, res) => {
  const node = param(req, 'node');
  const limit = Number(req.query.limit ?? 50);
  const list = [...tasks.values()].filter((t) => t.node === node).sort((a, b) => b.starttime - a.starttime).slice(0, limit);
  ok(res, list);
});

router.get('/nodes/:node/tasks/:upid/status', (req, res) => {
  const upid = param(req, 'upid');
  const t = tasks.get(upid);
  if (!t) return fail(res, 500, `no such task '${upid}'`);
  ok(res, { ...t });
});

router.get('/nodes/:node/qemu', (req, res) => {
  const node = param(req, 'node');
  ok(res, guests.filter((g) => g.node === node && g.type === 'qemu').map(guestResource));
});

router.get('/nodes/:node/lxc', (req, res) => {
  const node = param(req, 'node');
  ok(res, guests.filter((g) => g.node === node && g.type === 'lxc').map(guestResource));
});

router.get('/nodes/:node/:type/:vmid/config', (req, res) => {
  const g = findGuest(req, res);
  if (!g) return;
  ok(res, guestConfig(g));
});

router.get('/nodes/:node/:type/:vmid/status/current', (req, res) => {
  const g = findGuest(req, res);
  if (!g) return;
  const r = guestResource(g);
  ok(res, {
    ...r,
    cpus: g.cores,
    qmpstatus: g.status,
    ha: { managed: 0 },
    ...(g.type === 'qemu' ? { agent: g.config.agent ? 1 : 0 } : {}),
    ...mockStatusExtras(g),
  });
});

router.post('/nodes/:node/:type/:vmid/status/:action', (req, res) => {
  const g = findGuest(req, res);
  if (!g) return;
  const action = param(req, 'action');
  const L = label(g.type);
  if (g.template && action === 'start') return fail(res, 500, `you can't start a ${L} template`);

  const start = () => {
    g.status = 'running';
    g.startedAt = Date.now();
    g.mem = g.memoryMiB * MiB * 0.25;
    initSim(g);
  };
  const stop = () => {
    g.status = 'stopped';
    g.startedAt = null;
    g.mem = 0;
  };

  const plan: Record<string, { delay: number; work: () => string | void }> = {
    start: { delay: 1800, work: () => (g.status === 'running' ? `${L} ${g.vmid} already running` : start()) },
    stop: { delay: 900, work: () => stop() },
    shutdown: { delay: 3200, work: () => (g.status !== 'running' ? `${L} ${g.vmid} not running` : stop()) },
    reboot: { delay: 3800, work: () => (g.status !== 'running' ? `${L} ${g.vmid} not running` : void (g.startedAt = Date.now())) },
    suspend: { delay: 1500, work: () => (g.status !== 'running' ? `${L} ${g.vmid} not running` : stop()) },
    resume: { delay: 1500, work: () => (g.status === 'running' ? `${L} ${g.vmid} already running` : start()) },
  };
  const p = plan[action];
  if (!p) return fail(res, 501, `Method 'POST ${req.path}' not implemented`);
  const task = runTask(g.node, `${taskPrefix(g.type)}${action}`, String(g.vmid), p.work, p.delay);
  ok(res, task.upid);
});

router.get('/nodes/:node/:type/:vmid/snapshot', (req, res) => {
  const g = findGuest(req, res);
  if (!g) return;
  const last = g.snapshots[g.snapshots.length - 1];
  ok(res, [
    ...g.snapshots.map((s) => ({ ...s, vmstate: s.vmstate ? 1 : 0 })),
    { name: 'current', description: 'You are here!', running: g.status === 'running' ? 1 : 0, digest: 'abc123', ...(last ? { parent: last.name } : {}) },
  ]);
});

router.post('/nodes/:node/:type/:vmid/snapshot', (req, res) => {
  const g = findGuest(req, res);
  if (!g) return;
  const body = (req.body ?? {}) as Record<string, string>;
  const snapname = String(body.snapname ?? '');
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(snapname)) {
    return fail(res, 400, `Parameter verification failed. snapname: invalid format - invalid configuration ID '${snapname}'`);
  }
  if (snapname === 'current' || g.snapshots.some((s) => s.name === snapname)) {
    return fail(res, 500, `snapshot name '${snapname}' already used`);
  }
  const description = String(body.description ?? '');
  const vmstate = body.vmstate === '1' || body.vmstate === 'true';
  const task = runTask(
    g.node,
    `${taskPrefix(g.type)}snapshot`,
    String(g.vmid),
    () => {
      const parent = g.snapshots[g.snapshots.length - 1]?.name;
      const snap: MockSnapshot = { name: snapname, description, snaptime: secs(), vmstate: vmstate && g.status === 'running', ...(parent ? { parent } : {}) };
      g.snapshots.push(snap);
    },
    1200,
  );
  ok(res, task.upid);
});

router.delete('/nodes/:node/:type/:vmid/snapshot/:snapname', (req, res) => {
  const g = findGuest(req, res);
  if (!g) return;
  const snapname = param(req, 'snapname');
  if (!g.snapshots.some((s) => s.name === snapname)) return fail(res, 500, `snapshot '${snapname}' does not exist`);
  const task = runTask(
    g.node,
    `${taskPrefix(g.type)}delsnapshot`,
    String(g.vmid),
    () => {
      const idx = g.snapshots.findIndex((s) => s.name === snapname);
      if (idx === -1) throw new Error(`snapshot '${snapname}' does not exist`); // deleted by an earlier, queued task
      const removed = g.snapshots[idx];
      g.snapshots.splice(idx, 1);
      const child = g.snapshots.find((s) => s.parent === snapname);
      if (child) child.parent = removed?.parent;
    },
    1000,
  );
  ok(res, task.upid);
});

router.post('/nodes/:node/:type/:vmid/clone', (req, res) => {
  const g = findGuest(req, res);
  if (!g) return;
  const body = (req.body ?? {}) as Record<string, string>;
  const newid = Number(body.newid);
  if (!Number.isInteger(newid) || newid < 100 || newid > 999_999_999) return fail(res, 400, 'Parameter verification failed. newid: invalid');
  if (guests.some((x) => x.vmid === newid)) return fail(res, 500, `unable to create ${label(g.type)} ${newid}: config file already exists`);
  const target = body.target || g.node;
  if (!nodes.some((n) => n.name === target)) return fail(res, 500, `target node '${target}' does not exist`);
  const name = (g.type === 'lxc' ? body.hostname : body.name) || `${g.name}-clone`;
  const full = body.full === '1' || body.full === 'true' || !g.template;
  const targetStorage = body.storage;
  const DISK = /^(ide|sata|scsi|virtio)\d+$|^(efidisk|tpmstate)0$|^rootfs$|^mp\d+$/;
  const diskStorages = Object.entries(g.config)
    .filter(([k, v]) => DISK.test(k) && typeof v === 'string' && !v.includes('media=cdrom') && !v.includes('cloudinit'))
    .map(([, v]) => String(v).split(':')[0]!);
  // Real Proxmox: cloning to another node only works when the source disks are on shared storage.
  if (target !== g.node && diskStorages.some((s) => !storages.find((x) => x.name === s && x.nodes.includes(g.node))?.shared)) {
    return fail(res, 500, `can't clone ${label(g.type)} to node '${target}' (${label(g.type)} uses local storage)`);
  }
  if (targetStorage) {
    const st = storages.find((x) => x.name === targetStorage && x.nodes.includes(target));
    if (!st) return fail(res, 500, `storage '${targetStorage}' does not exist on node '${target}'`);
    if (!st.content.includes(g.type === 'qemu' ? 'images' : 'rootdir')) return fail(res, 500, `storage '${targetStorage}' does not support ${g.type === 'qemu' ? 'VM images' : 'container directories'}`);
  }

  const task = runTask(
    g.node,
    `${taskPrefix(g.type)}clone`,
    String(g.vmid),
    () => {
      const config: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(g.config)) {
        if (k === 'template') continue;
        let val = typeof v === 'string' ? v.replaceAll(`-${g.vmid}-`, `-${newid}-`).replace(/base-\d+-/g, `vm-${newid}-`) : v;
        if (targetStorage && typeof val === 'string' && DISK.test(k) && !val.includes('media=cdrom')) val = val.replace(/^[^:]+:/, `${targetStorage}:`);
        config[k] = val;
      }
      if (g.type === 'lxc') config.hostname = name;
      else config.name = name;
      if (body.description !== undefined) config.description = body.description;
      guests.push({
        ...g,
        vmid: newid,
        node: target,
        name,
        status: 'stopped',
        template: false,
        config,
        startedAt: null,
        cpu: 0,
        mem: 0,
        snapshots: [],
        sim: undefined,
        tags: g.tags.filter((t) => t !== 'template'),
      });
    },
    full ? 3000 : 1500,
    full ? 'cloning disks' : undefined,
  );
  ok(res, task.upid);
});

registerLabRoutes(router);

router.use((req, res) => fail(res, 501, `Method '${req.method} ${req.path}' not implemented`));

export { GiB };
