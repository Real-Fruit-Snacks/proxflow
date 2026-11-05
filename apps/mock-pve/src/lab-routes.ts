/**
 * Mock endpoints used by ProxFlow's lab builder. Where real Proxmox enforces a rule we're confident
 * about (shared storage for cross-node clones, can't delete a running VM, content types per storage…),
 * the mock enforces it too, so the planner gets exercised against realistic failures.
 */
import express, { type Request, type Response, type Router } from 'express';
import { readIso } from './iso.js';
import { parseMultipart } from './multipart.js';
import { agentUp, guestIp, initSim, onExec, onFileWrite, onSendKey, openPorts, statusFile } from './sim.js';
import { GiB, MiB, bridges, guests, mac, nodes, runTask, storages, tasks, volumes, type MockGuest, type MockVolume } from './state.js';

const ok = (res: Response, data: unknown) => res.json({ data });
const fail = (res: Response, status: number, message: string) => res.status(status).json({ data: null, message, errors: { message } });
const p = (req: Request, name: string) => String((req.params as Record<string, string>)[name] ?? '');
const body = (req: Request) => (req.body ?? {}) as Record<string, string | string[]>;
const str = (v: unknown) => (Array.isArray(v) ? String(v[0] ?? '') : v === undefined ? '' : String(v));

const storageOn = (name: string, node: string) => storages.find((s) => s.name === name && s.nodes.includes(node));
const visible = (v: MockVolume, node: string) => v.node === undefined || v.node === node;
const findVolume = (volid: string, node: string) => volumes.find((v) => v.volid === volid && visible(v, node));
const findGuest = (vmid: number) => guests.find((g) => g.vmid === vmid);
const DRIVE = /^(ide|sata|scsi|virtio)\d+$|^(efidisk|tpmstate)0$/;
const FORMAT: Record<string, string> = { iso: 'iso', vztmpl: 'tzst', backup: 'vma.zst', import: 'qcow2' };

function guestOr404(req: Request, res: Response): MockGuest | null {
  const g = findGuest(Number(p(req, 'vmid')));
  const type = p(req, 'type') || req.path.split('/')[3];
  if (!g || g.node !== p(req, 'node') || (type && type !== g.type && (type === 'qemu' || type === 'lxc'))) {
    fail(res, 500, `Configuration file 'nodes/${p(req, 'node')}/${type === 'lxc' ? 'lxc' : 'qemu-server'}/${p(req, 'vmid')}.conf' does not exist`);
    return null;
  }
  return g;
}

/** "local-lvm:32" / "local-lvm:0,import-from=…" → a concrete disk spec, or an error message. */
function allocDisk(node: string, vmid: number, key: string, value: string, n: number, kind: 'images' | 'rootdir'): { spec: string; bytes: number; from?: MockVolume } | string {
  const [head, ...rest] = value.split(',');
  const colon = head!.indexOf(':');
  const storage = head!.slice(0, colon);
  const size = head!.slice(colon + 1);
  const st = storageOn(storage, node);
  if (!st) return `storage '${storage}' does not exist on node '${node}'`;
  if (!st.content.includes(kind)) return `storage '${storage}' does not support content-type '${kind}'`;
  const opts = rest.filter((o) => !o.startsWith('import-from='));
  const importFrom = rest.find((o) => o.startsWith('import-from='))?.slice(12);
  let bytes = Number(size) * GiB;
  let from: MockVolume | undefined;
  if (importFrom) {
    from = findVolume(importFrom, node);
    if (!from) return `${key}: import-from volume '${importFrom}' does not exist`;
    if (from.content !== 'import') return `${key}: '${importFrom}' has wrong type '${from.content}' - needs to be 'images' or 'import'`;
    bytes = from.virtualSize ?? 3 * GiB;
  }
  if (key === 'efidisk0') bytes = 4 * MiB;
  if (!(bytes > 0)) return `${key}: invalid size '${size}'`;
  const gib = Math.max(0.01, Math.round((bytes / GiB) * 100) / 100);
  return { spec: [`${storage}:vm-${vmid}-disk-${n}`, ...opts.filter((o) => !o.startsWith('size=')), `size=${key === 'efidisk0' ? '4M' : `${gib}G`}`].join(','), bytes, from };
}

function checkNet(node: string, value: string): string | undefined {
  const bridge = /bridge=([^,]+)/.exec(value)?.[1];
  if (bridge && !bridges.some((b) => b.node === node && b.iface === bridge)) return `bridge '${bridge}' does not exist`;
  return undefined;
}

function checkCdrom(node: string, value: string): string | undefined {
  const vol = value.split(',')[0]!;
  if (vol === 'none' || vol === 'cdrom' || !value.includes('media=cdrom')) return undefined;
  if (!findVolume(vol, node)) return `volume '${vol}' does not exist`;
  return undefined;
}

const configToText = (cfg: string) =>
  Object.fromEntries(
    cfg
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const i = l.indexOf(':');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      }),
  ) as Record<string, string>;

function newGuest(node: string, type: 'qemu' | 'lxc', vmid: number, cfg: Record<string, string | number>, extra: Partial<MockGuest> = {}): MockGuest {
  const disks = Object.entries(cfg).filter(([k, v]) => (DRIVE.test(k) || k === 'rootfs' || /^mp\d+$/.test(k)) && typeof v === 'string' && !v.includes('media=cdrom'));
  const maxdisk = disks.reduce((a, [, v]) => a + (Number(/size=([\d.]+)G/.exec(String(v))?.[1] ?? 0) * GiB), 0);
  return {
    type,
    vmid,
    node,
    name: String(cfg.name ?? cfg.hostname ?? `${type}-${vmid}`),
    status: 'stopped',
    template: String(cfg.template ?? '') === '1',
    cores: Number(cfg.cores ?? 1),
    memoryMiB: Number(cfg.memory ?? 512),
    maxdisk,
    ostype: String(cfg.ostype ?? (type === 'lxc' ? 'debian' : 'other')),
    tags: String(cfg.tags ?? '').split(/[;,]/).filter(Boolean),
    config: cfg,
    startedAt: null,
    baseCpu: 0.06,
    cpu: 0,
    mem: 0,
    snapshots: [],
    ...extra,
  };
}

/** Rewrites disks restored from a backup onto the target storage with this VMID. */
function restoreDisks(cfg: Record<string, string>, vmid: number, storage: string, template: boolean) {
  let n = 0;
  for (const [k, v] of Object.entries(cfg)) {
    if (!(DRIVE.test(k) || k === 'rootfs') || v.includes('media=cdrom') || v.includes('cloudinit')) continue;
    const opts = v.split(',').slice(1);
    cfg[k] = [`${storage}:${template ? 'base' : 'vm'}-${vmid}-disk-${n++}`, ...opts].join(',');
  }
  for (const [k, v] of Object.entries(cfg)) if (v.includes('cloudinit')) cfg[k] = `${storage}:vm-${vmid}-cloudinit,media=cdrom`;
}

export function registerLabRoutes(router: Router) {
  router.get('/cluster/nextid', (_req, res) => {
    let id = 100;
    while (guests.some((g) => g.vmid === id)) id++;
    ok(res, String(id));
  });

  // ───── storage ─────

  router.get('/nodes/:node/storage', (req, res) => {
    const node = p(req, 'node');
    ok(
      res,
      storages
        .filter((s) => s.nodes.includes(node))
        .map((s) => ({ storage: s.name, type: s.type, content: s.content.join(','), active: 1, enabled: 1, shared: s.shared ? 1 : 0, total: s.total, used: s.used, avail: s.total - s.used })),
    );
  });

  router.get('/storage/:storage', (req, res) => {
    const s = storages.find((x) => x.name === p(req, 'storage'));
    if (!s) return fail(res, 500, `storage '${p(req, 'storage')}' does not exist`);
    ok(res, { storage: s.name, type: s.type, content: s.content.join(','), digest: 'mock' });
  });

  router.put('/storage/:storage', (req, res) => {
    const name = p(req, 'storage');
    const defs = storages.filter((x) => x.name === name);
    if (!defs.length) return fail(res, 500, `storage '${name}' does not exist`);
    const content = str(body(req).content).split(',').filter(Boolean);
    const allowed = ['images', 'rootdir', 'iso', 'vztmpl', 'backup', 'snippets', 'import'];
    const bad = content.find((c) => !allowed.includes(c));
    if (bad) return fail(res, 400, `Parameter verification failed. content: invalid format - unknown content type '${bad}'`);
    for (const d of defs) d.content = content;
    ok(res, null);
  });

  router.get('/nodes/:node/storage/:storage/content', (req, res) => {
    const node = p(req, 'node');
    const storage = p(req, 'storage');
    if (!storageOn(storage, node)) return fail(res, 500, `storage '${storage}' does not exist on node '${node}'`);
    const content = typeof req.query.content === 'string' ? req.query.content : undefined;
    ok(
      res,
      volumes
        .filter((v) => v.storage === storage && visible(v, node) && (!content || v.content === content))
        .map((v) => ({
          volid: v.volid,
          content: v.content,
          format: FORMAT[v.content],
          size: v.size,
          ctime: v.ctime,
          ...(v.notes ? { notes: v.notes } : {}),
          ...(v.subtype ? { subtype: v.subtype, vmid: Number(/vzdump-\w+-(\d+)-/.exec(v.volid)?.[1]) || undefined } : {}),
        })),
    );
  });

  router.get('/nodes/:node/vzdump/extractconfig', (req, res) => {
    const v = findVolume(String(req.query.volume ?? ''), p(req, 'node'));
    if (!v?.backupConfig) return fail(res, 500, `volume '${String(req.query.volume)}' does not exist or is not a backup`);
    ok(res, v.backupConfig);
  });

  router.post('/nodes/:node/storage/:storage/download-url', (req, res) => {
    const node = p(req, 'node');
    const storage = p(req, 'storage');
    const b = body(req);
    const content = str(b.content) as MockVolume['content'];
    const filename = str(b.filename);
    const st = storageOn(storage, node);
    if (!st) return fail(res, 500, `storage '${storage}' does not exist on node '${node}'`);
    if (!st.content.includes(content)) return fail(res, 500, `storage '${storage}' does not support content-type '${content}'`);
    const ext: Record<string, RegExp> = { iso: /\.(iso|img)$/i, vztmpl: /\.tar\.(gz|xz|zst)$/i, import: /\.(qcow2|raw|vmdk|img|ova)$/i };
    if (!ext[content]?.test(filename)) return fail(res, 400, `Parameter verification failed. filename: invalid name for content '${content}'`);
    const volid = `${storage}:${content}/${filename}`;
    if (volumes.some((v) => v.volid === volid && visible(v, node))) return fail(res, 500, `refusing to override existing file '${filename}'`);
    const task = runTask(node, 'download', storage, () => {
      volumes.push({ volid, storage, node: st.shared ? undefined : node, content, size: 600 * MiB, ctime: Math.floor(Date.now() / 1000), ...(content === 'import' ? { virtualSize: 3.5 * GiB, box: { os: 'linux', agent: false, cloudInit: true } } : {}) });
    }, 4000, `downloading ${str(b.url)}`);
    ok(res, task.upid);
  });

  router.post('/nodes/:node/storage/:storage/upload', express.raw({ type: 'multipart/form-data', limit: '64mb' }), (req, res) => {
    const node = p(req, 'node');
    const storage = p(req, 'storage');
    const st = storageOn(storage, node);
    if (!st) return fail(res, 500, `storage '${storage}' does not exist on node '${node}'`);
    let parts;
    try {
      parts = parseMultipart(req.body as Buffer, req.header('content-type') ?? '');
    } catch (e) {
      return fail(res, 400, `bad multipart body: ${e instanceof Error ? e.message : e}`);
    }
    const contentIdx = parts.findIndex((x) => x.name === 'content');
    const fileIdx = parts.findIndex((x) => x.name === 'filename' && x.filename);
    if (contentIdx === -1 || fileIdx === -1) return fail(res, 400, 'upload needs "content" and a "filename" file part');
    if (contentIdx > fileIdx) return fail(res, 400, 'the "content" parameter must come before the file');
    const content = parts[contentIdx]!.data.toString() as MockVolume['content'];
    const file = parts[fileIdx]!;
    if (!st.content.includes(content)) return fail(res, 500, `storage '${storage}' does not support content-type '${content}'`);
    if (content === 'iso' && !/\.(iso|img)$/i.test(file.filename!)) return fail(res, 400, 'wrong file extension');
    let files: MockVolume['files'];
    if (content === 'iso') {
      try {
        files = readIso(file.data); // the mock's independent reader: a broken ISO fails loudly here
      } catch (e) {
        return fail(res, 500, `mock: uploaded file is not a valid ISO 9660 image: ${e instanceof Error ? e.message : e}`);
      }
    }
    const volid = `${storage}:${content}/${file.filename}`;
    volumes.splice(0, volumes.length, ...volumes.filter((v) => !(v.volid === volid && visible(v, node))));
    const task = runTask(node, 'imgcopy', '', () => {
      volumes.push({ volid, storage, node: st.shared ? undefined : node, content, size: file.data.length, ctime: Math.floor(Date.now() / 1000), files });
    }, 500);
    ok(res, task.upid);
  });

  router.delete('/nodes/:node/storage/:storage/content/:volume', (req, res) => {
    const node = p(req, 'node');
    const volid = p(req, 'volume').includes(':') ? p(req, 'volume') : `${p(req, 'storage')}:${p(req, 'volume')}`;
    const v = findVolume(volid, node);
    if (!v) return fail(res, 500, `volume '${volid}' does not exist`);
    const task = runTask(node, 'imgdel', '', () => {
      const i = volumes.indexOf(v);
      if (i >= 0) volumes.splice(i, 1);
    }, 400);
    ok(res, task.upid);
  });

  // ───── create / restore ─────

  router.post('/nodes/:node/qemu', (req, res) => {
    const node = p(req, 'node');
    const b = body(req);
    const vmid = Number(str(b.vmid));
    if (!Number.isInteger(vmid) || vmid < 100) return fail(res, 400, 'Parameter verification failed. vmid: invalid');
    if (findGuest(vmid)) return fail(res, 500, `unable to create VM ${vmid} - VM ${vmid} already exists on node '${findGuest(vmid)!.node}'`);

    if (b.archive) {
      const v = findVolume(str(b.archive), node);
      if (!v || v.content !== 'backup' || v.subtype !== 'qemu') return fail(res, 500, `can't find backup '${str(b.archive)}'`);
      const storage = str(b.storage);
      const st = storageOn(storage, node);
      if (!st?.content.includes('images')) return fail(res, 500, `storage '${storage}' does not support VM images`);
      const cfg = configToText(v.backupConfig ?? '');
      restoreDisks(cfg, vmid, storage, cfg.template === '1');
      if (str(b.unique) === '1' && cfg.net0) cfg.net0 = cfg.net0.replace(/=([0-9A-F:]{17})/i, `=${mac(vmid, 0)}`);
      const g = newGuest(node, 'qemu', vmid, cfg, { box: v.box });
      const task = runTask(node, 'qmrestore', String(vmid), () => void guests.push(g), 3000, `restoring ${v.volid}`);
      return ok(res, task.upid);
    }

    const cfg: Record<string, string | number> = {};
    let n = 0;
    let box: MockGuest['box'];
    for (const [k, raw] of Object.entries(b)) {
      if (k === 'vmid' || k === 'start') continue;
      const v = str(raw);
      if (DRIVE.test(k) && !v.includes('media=cdrom')) {
        const d = allocDisk(node, vmid, k, v, n++, 'images');
        if (typeof d === 'string') return fail(res, 500, `unable to create VM ${vmid} - ${d}`);
        cfg[k] = d.spec;
        if (d.from?.box) box = d.from.box;
      } else if (DRIVE.test(k)) {
        const err = checkCdrom(node, v);
        if (err) return fail(res, 500, `unable to create VM ${vmid} - ${k}: ${err}`);
        cfg[k] = v;
      } else if (/^net\d+$/.test(k)) {
        const err = checkNet(node, v);
        if (err) return fail(res, 500, `unable to create VM ${vmid} - ${k}: ${err}`);
        cfg[k] = v;
      } else cfg[k] = v;
    }
    const importing = Object.values(b).some((v) => str(v).includes('import-from='));
    const g = newGuest(node, 'qemu', vmid, cfg, { box });
    const task = runTask(node, 'qmcreate', String(vmid), () => void guests.push(g), importing ? 3500 : 1500, importing ? 'importing disk' : undefined);
    ok(res, task.upid);
  });

  router.post('/nodes/:node/lxc', (req, res) => {
    const node = p(req, 'node');
    const b = body(req);
    const vmid = Number(str(b.vmid));
    if (!Number.isInteger(vmid) || vmid < 100) return fail(res, 400, 'Parameter verification failed. vmid: invalid');
    if (findGuest(vmid)) return fail(res, 500, `unable to create CT ${vmid} - CT ${vmid} already exists on node '${findGuest(vmid)!.node}'`);
    const tmpl = findVolume(str(b.ostemplate), node);
    const restore = str(b.restore) === '1';
    if (!tmpl || tmpl.content !== (restore ? 'backup' : 'vztmpl')) return fail(res, 500, `${restore ? 'backup' : 'template'} '${str(b.ostemplate)}' does not exist`);
    if (b.password && str(b.password).length < 5) return fail(res, 400, 'Parameter verification failed. password: value must be at least 5 characters long');
    let cfg: Record<string, string | number>;
    if (restore) {
      const storage = str(b.storage);
      if (!storageOn(storage, node)?.content.includes('rootdir')) return fail(res, 500, `storage '${storage}' does not support container directories`);
      const c = configToText(tmpl.backupConfig ?? '');
      restoreDisks(c, vmid, storage, c.template === '1');
      cfg = c;
    } else {
      const rootfs = allocDisk(node, vmid, 'rootfs', str(b.rootfs), 0, 'rootdir');
      if (typeof rootfs === 'string') return fail(res, 500, `unable to create CT ${vmid} - ${rootfs}`);
      cfg = { arch: 'amd64', ostype: tmpl.volid.split('/')[1]!.split('-')[0]!, rootfs: rootfs.spec };
      for (const k of ['hostname', 'cores', 'memory', 'swap', 'net0', 'nameserver', 'searchdomain', 'unprivileged', 'features', 'onboot', 'tags', 'description']) if (b[k] !== undefined) cfg[k] = str(b[k]);
      const err = cfg.net0 ? checkNet(node, String(cfg.net0)) : undefined;
      if (err) return fail(res, 500, `unable to create CT ${vmid} - net0: ${err}`);
    }
    const g = newGuest(node, 'lxc', vmid, cfg);
    const task = runTask(node, restore ? 'vzrestore' : 'vzcreate', String(vmid), () => {
      guests.push(g);
      if (str(b.start) === '1') {
        g.status = 'running';
        g.startedAt = Date.now();
      }
    }, restore ? 2500 : 1500);
    ok(res, task.upid);
  });

  router.post('/nodes/:node/:type/:vmid/template', (req, res) => {
    const g = guestOr404(req, res);
    if (!g) return;
    if (g.status === 'running') return fail(res, 500, `${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid} is running - can't convert to template`);
    const task = runTask(g.node, g.type === 'qemu' ? 'qmtemplate' : 'vztemplate', String(g.vmid), () => {
      g.template = true;
      g.config.template = 1;
      for (const [k, v] of Object.entries(g.config)) if (typeof v === 'string') g.config[k] = v.replace(`vm-${g.vmid}-disk-`, `base-${g.vmid}-disk-`);
    }, 800);
    ok(res, task.upid);
  });

  // ───── config / resize / destroy ─────

  const applyConfig = (g: MockGuest, b: Record<string, string | string[]>): string | undefined => {
    for (const k of str(b.delete).split(/[,;\s]+/).filter(Boolean)) delete g.config[k];
    for (const [k, raw] of Object.entries(b)) {
      if (k === 'delete' || k === 'digest') continue;
      const v = str(raw);
      if (DRIVE.test(k)) {
        const err = checkCdrom(g.node, v);
        if (err) return `${k}: ${err}`;
      }
      if (/^net\d+$/.test(k)) {
        const err = checkNet(g.node, v);
        if (err) return `${k}: ${err}`;
      }
      g.config[k] = v;
      if (k === 'name' || k === 'hostname') g.name = v;
      if (k === 'cores') g.cores = Number(v);
      if (k === 'memory') g.memoryMiB = Number(v);
      if (k === 'tags') g.tags = v.split(/[;,]/).filter(Boolean);
    }
    return undefined;
  };

  router.put('/nodes/:node/:type/:vmid/config', (req, res) => {
    const g = guestOr404(req, res);
    if (!g) return;
    const err = applyConfig(g, body(req));
    if (err) return fail(res, 500, err);
    ok(res, null);
  });

  router.post('/nodes/:node/:type/:vmid/config', (req, res) => {
    const g = guestOr404(req, res);
    if (!g) return;
    const err = applyConfig(g, body(req));
    if (err) return fail(res, 500, err);
    ok(res, runTask(g.node, 'qmconfig', String(g.vmid), () => undefined, 300).upid);
  });

  router.put('/nodes/:node/:type/:vmid/resize', (req, res) => {
    const g = guestOr404(req, res);
    if (!g) return;
    const b = body(req);
    const disk = str(b.disk);
    const cur = String(g.config[disk] ?? '');
    if (!cur) return fail(res, 500, `disk '${disk}' does not exist`);
    const curG = Number(/size=([\d.]+)G/.exec(cur)?.[1] ?? 0);
    const m = /^(\+?)(\d+(?:\.\d+)?)G$/.exec(str(b.size));
    if (!m) return fail(res, 400, 'Parameter verification failed. size: invalid format');
    const next = m[1] ? curG + Number(m[2]) : Number(m[2]);
    if (next < curG) return fail(res, 500, 'shrinking disks is not supported');
    const task = runTask(g.node, 'resize', String(g.vmid), () => {
      g.config[disk] = cur.replace(/size=[\d.]+G/, `size=${next}G`);
      g.maxdisk += (next - curG) * GiB;
    }, 500);
    ok(res, task.upid);
  });

  router.delete('/nodes/:node/:type/:vmid', (req, res) => {
    const g = guestOr404(req, res);
    if (!g) return;
    if (g.status === 'running') return fail(res, 500, `${g.type === 'qemu' ? 'VM' : 'CT'} ${g.vmid} is running - destroy failed`);
    const task = runTask(g.node, g.type === 'qemu' ? 'qmdestroy' : 'vzdestroy', String(g.vmid), () => {
      const i = guests.indexOf(g);
      if (i >= 0) guests.splice(i, 1);
    }, 800);
    ok(res, task.upid);
  });

  // ───── console / agent / container interfaces ─────

  router.put('/nodes/:node/qemu/:vmid/sendkey', (req, res) => {
    const g = guestOr404(req, res);
    if (!g) return;
    if (g.status !== 'running') return fail(res, 500, `VM ${g.vmid} not running`);
    onSendKey(g, str(body(req).key));
    ok(res, null);
  });

  router.get('/nodes/:node/lxc/:vmid/interfaces', (req, res) => {
    const g = guestOr404(req, res);
    if (!g) return;
    if (g.status !== 'running') return fail(res, 500, `CT ${g.vmid} not running`);
    const net0 = String(g.config.net0 ?? '');
    const ip = /ip=([^,]+)/.exec(net0)?.[1];
    const up = g.startedAt && Date.now() - g.startedAt > 2000;
    const addr = ip && ip !== 'dhcp' ? ip : `192.168.1.${100 + (g.vmid % 100)}/24`;
    ok(res, [{ name: 'lo', inet: '127.0.0.1/8' }, { name: 'eth0', hwaddr: /hwaddr=([^,]+)/.exec(net0)?.[1], ...(up ? { inet: addr } : {}) }]);
  });

  const agentGuest = (req: Request, res: Response): MockGuest | null => {
    const g = guestOr404(req, res);
    if (!g) return null;
    if (g.status !== 'running') {
      fail(res, 500, `VM ${g.vmid} is not running`);
      return null;
    }
    if (!/^1|enabled=1/.test(String(g.config.agent ?? ''))) {
      fail(res, 500, 'No QEMU guest agent configured');
      return null;
    }
    if (!agentUp(g, guests)) {
      fail(res, 500, 'QEMU guest agent is not running');
      return null;
    }
    return g;
  };

  router.post('/nodes/:node/qemu/:vmid/agent/ping', (req, res) => {
    if (agentGuest(req, res)) ok(res, { result: {} });
  });

  router.get('/nodes/:node/qemu/:vmid/agent/network-get-interfaces', (req, res) => {
    const g = agentGuest(req, res);
    if (!g) return;
    const { ip, prefix } = guestIp(g);
    const hw = (/=([0-9A-F:]{17})/i.exec(String(g.config.net0 ?? ''))?.[1] ?? '').toLowerCase();
    ok(res, {
      result: [
        { name: 'lo', 'ip-addresses': [{ 'ip-address': '127.0.0.1', 'ip-address-type': 'ipv4', prefix: 8 }] },
        { name: g.box?.os === 'windows' || g.sim?.kind?.startsWith('windows') ? 'Ethernet' : 'ens18', 'hardware-address': hw, 'ip-addresses': [{ 'ip-address': ip, 'ip-address-type': 'ipv4', prefix }] },
      ],
    });
  });

  router.get('/nodes/:node/qemu/:vmid/agent/file-read', (req, res) => {
    const g = agentGuest(req, res);
    if (!g) return;
    const file = String(req.query.file ?? '');
    const content = /proxflow[\\/]status/i.test(file) ? statusFile(g, guests) : null;
    if (content === null) return fail(res, 500, `Failed to open file '${file}': No such file or directory`);
    ok(res, { content, truncated: false });
  });

  router.post('/nodes/:node/qemu/:vmid/agent/file-write', (req, res) => {
    const g = agentGuest(req, res);
    if (!g) return;
    onFileWrite(g, str(body(req).content));
    ok(res, null);
  });

  let pid = 1000;
  router.post('/nodes/:node/qemu/:vmid/agent/exec', (req, res) => {
    const g = agentGuest(req, res);
    if (!g) return;
    const cmd = body(req).command;
    onExec(g, Array.isArray(cmd) ? cmd : [str(cmd)]);
    ok(res, { pid: pid++ });
  });

  router.get('/nodes/:node/qemu/:vmid/agent/exec-status', (req, res) => {
    if (agentGuest(req, res)) ok(res, { exited: 1, exitcode: 0 });
  });

  router.get('/nodes/:node/tasks/:upid/log', (req, res) => {
    const t = tasks.get(p(req, 'upid'));
    if (!t) return fail(res, 500, `no such task '${p(req, 'upid')}'`);
    ok(res, t.log.map((line, i) => ({ n: i + 1, t: line })));
  });
}

/** Extra mock-only fields for status/current: simulated open ports (see build/steps.ts probePort). */
export const mockStatusExtras = (g: MockGuest) => ({ 'proxflow-mock-ports': openPorts(g, guests) });
export { initSim, nodes };
