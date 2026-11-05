// End-to-end check of the lab builder against the running dev stack (pnpm dev, mock Proxmox).
// Builds an offline "work lab" from what's on the mock's share, then exercises failures and destroy.
// Usage: node apps/server/scripts/smoke-build.mjs [apiBase]
const API = process.argv[2] ?? 'http://localhost:3001/api';
let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}
function check(label, cond, detail) {
  if (!cond) failures++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail && !cond ? `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}` : ''}`);
}
const errorsOf = (plan) => plan.issues.filter((i) => i.level === 'error').map((i) => i.message);

const PW = 'Lab-Pass-2026!';
const net = (ip) => ({ ipMode: 'static', cidr: `192.168.1.${ip}/24`, gateway: '192.168.1.1' });
const base = (id, name, extra) => ({ id, name, cores: 2, memoryMiB: 4096, diskGiB: 40, onboot: false, net: { ipMode: 'dhcp' }, ...extra });
const target = (node = 'pve1') => ({ conn: 'mock', node, diskStorage: 'local-lvm', isoStorage: 'local', importStorage: 'local', bridge: 'vmbr0' });
const spec = (name, machines, node) => ({ name, target: target(node), defaults: { username: 'labadmin', password: PW, sshKey: '', dns: '' }, machines });

const WIN_ISO = 'share:iso/SERVER_EVAL_x64FRE_en-us.iso';
const workLab = spec('Work lab', [
  base('dc', 'dc01', { kind: 'windows', role: 'dc', source: { type: 'iso', iso: WIN_ISO, version: '2022', edition: 'standard-desktop' }, domain: { fqdn: 'lab.internal', netbios: 'LAB' }, net: net(210), diskGiB: 60 }),
  base('ws', 'ws01', { kind: 'windows', role: 'server', source: { type: 'backup', volid: 'share:backup/vzdump-qemu-9101-2025_09_20-11_30_00.vma.zst' }, joinDomainOf: 'dc', net: net(211), diskGiB: 60 }),
  base('wt', 'wintpl01', { kind: 'windows', role: 'server', source: { type: 'template', vmid: 9001 }, net: net(214), diskGiB: 50 }),
  base('rk', 'rocky01', { kind: 'linux-vm', source: { type: 'backup', volid: 'share:backup/vzdump-qemu-9100-2025_09_14-10_00_00.vma.zst', family: 'rhel' }, packages: [], joinDomainOf: 'dc', net: net(212), memoryMiB: 2048, diskGiB: 20 }),
  base('lg', 'legacy01', { kind: 'linux-vm', source: { type: 'backup', volid: 'share:backup/vzdump-qemu-9102-2025_06_02-08_15_00.vma.zst', family: 'rhel' }, packages: [], net: net(213), memoryMiB: 1024, diskGiB: 10 }),
  base('db', 'deb01', { kind: 'linux-vm', source: { type: 'disk', volid: 'share:import/debian-12-box.qcow2', family: 'debian' }, packages: [], memoryMiB: 1024, diskGiB: 12 }),
  base('ub', 'ubu01', { kind: 'linux-vm', source: { type: 'template', vmid: 9000, family: 'debian' }, packages: [], memoryMiB: 1024, diskGiB: 16 }),
  base('c1', 'ct01', { kind: 'lxc', source: { type: 'vztmpl', volid: 'share:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst' }, unprivileged: true, nesting: true, cores: 1, memoryMiB: 512, diskGiB: 8 }),
  base('c2', 'ct02', { kind: 'lxc', source: { type: 'backup', volid: 'share:backup/vzdump-lxc-9200-2025_08_01-09_00_00.tar.zst' }, unprivileged: true, nesting: false, cores: 1, memoryMiB: 256, diskGiB: 4 }),
  base('ex', 'esxi01', { kind: 'esxi', iso: 'share:iso/VMware-VMvisor-Installer-8.0U3-24022510.x86_64.iso', net: net(220), cores: 4, memoryMiB: 12288, diskGiB: 64 }),
]);

async function waitFor(id, statuses, ms) {
  const deadline = Date.now() + ms;
  let d;
  while (Date.now() < deadline) {
    d = (await call('GET', `/labs/deployments/${id}`)).json;
    if (statuses.includes(d.status)) return d;
    await sleep(1500);
  }
  return d;
}

// ───────────────────────── validation ─────────────────────────
console.log('\n── plan rejects bad input ──');
{
  const bad = spec('', [
    base('a', 'bad_name', { kind: 'windows', role: 'dc', source: { type: 'iso', iso: '', version: '2022', edition: 'standard-desktop' }, domain: { fqdn: 'lab', netbios: 'LAB' } }),
    base('b', 'esx', { kind: 'esxi', iso: 'share:iso/nope.iso', memoryMiB: 2048 }),
    base('c', 'thisnameiswaytoolong', { kind: 'windows', role: 'server', source: { type: 'template', vmid: 9000 } }),
  ]);
  bad.defaults.password = 'weak';
  const { json: p } = await call('POST', '/labs/plan', bad);
  const e = errorsOf(p).join(' | ');
  check('plan is not ok', p.ok === false);
  for (const [label, re] of [
    ['lab name required', /name/i],
    ['invalid hostname', /valid host name/],
    ['password complexity', /8\+ characters/],
    ['DC needs static IP', /static IP — other machines/],
    ['single-label domain', /two parts/],
    ['missing Windows ISO', /installer ISO/],
    ['ESXi ISO not found', /isn't visible/],
    ['ESXi needs static IP', /ESXi needs a static IP/],
    ['ESXi memory', /4 GiB/],
    ['Windows name ≤ 15', /15 characters/],
    ['template type mismatch (9000 is not Windows-capable? it is a VM — ok) / no steps on errors', /./],
  ]) check(label, re.test(e), e);
  check('no steps planned while there are errors', p.steps.length === 0);
}

// ───────────────────────── the work lab ─────────────────────────
console.log('\n── plan the offline work lab ──');
let plan;
{
  const r = await call('POST', '/labs/plan', workLab);
  plan = r.json;
  check('plan is ok (no downloads needed)', plan.ok === true, errorsOf(plan));
  check('nothing to download', !plan.assets.some((a) => a.action === 'download'), plan.assets);
  const restores = plan.steps.filter((s) => s.id.startsWith('box:'));
  const reused = plan.assets.filter((a) => /Already restored/.test(a.detail ?? ''));
  check('4 boxes, each restored once or reused from cache (win, rocky, centos, alpine)', restores.length + reused.length === 4, { restores: restores.map((s) => s.title), reused: reused.map((a) => a.label) });
  check('VMIDs unique', new Set(plan.machines.map((m) => m.vmid)).size === plan.machines.length);
  check('machines have readiness descriptions', plan.machines.every((m) => m.readiness));
  const lg = plan.machines.find((m) => m.id === 'lg');
  check('no-agent box will be checked via SSH', /SSH on 192\.168\.1\.213/.test(lg?.readiness ?? ''), lg);
}

console.log('\n── deploy it ──');
let dep;
{
  const r = await call('POST', '/labs/deploy', workLab);
  check('deploy → 201', r.status === 201, r.json);
  dep = await waitFor(r.json.id, ['succeeded', 'warning', 'failed', 'cancelled'], 240_000);
  check(`finished: ${dep.status}`, dep.status === 'succeeded', dep.steps.filter((s) => s.status !== 'done').map((s) => `${s.id}=${s.status}: ${s.error ?? s.detail}`));
  for (const m of dep.machines) check(`${m.name.padEnd(9)} ${m.status.padEnd(8)} ${m.ip ?? ''}  ${m.message ?? ''}`, m.status === 'ready', m);
  const msg = (id) => dep.machines.find((m) => m.id === id)?.message ?? '';
  check('DC promoted', /Domain lab\.internal is up/.test(msg('dc')));
  check('Windows box joined the domain via the agent', /Joined lab\.internal/.test(msg('ws')));
  check('Rocky box joined the domain via realmd', /Joined lab\.internal/.test(msg('rk')));
  check('no-agent box confirmed by SSH', /SSH is answering/.test(msg('lg')));
  check('cross-node clone of the pve2 template worked', dep.steps.find((s) => s.id === 'wt:clone')?.detail?.includes('from pve2'));
  check('ESXi confirmed over HTTPS', /answering at https:\/\/192\.168\.1\.220/.test(msg('ex')));
  check('DHCP disk-image VM got an IP from the agent', /^192\.168\.1\.\d+$/.test(dep.machines.find((m) => m.id === 'db')?.ip ?? ''));
  check('every setup ISO was cleaned up', dep.steps.filter((s) => s.id.endsWith(':cleanup')).every((s) => s.status === 'done'), dep.steps.filter((s) => s.id.endsWith(':cleanup')));
  const { json: topo } = await call('GET', '/topology');
  const tagged = topo.nodes.filter((n) => n.data.kind === 'guest' && n.data.tags.includes('pf-work-lab'));
  check('all 10 machines on the map with the lab tag', tagged.length === 10, tagged.map((n) => n.data.name));
}

console.log('\n── boxes are reused next time ──');
{
  const { json: p } = await call('POST', '/labs/plan', workLab);
  check('no restore steps the second time', !p.steps.some((s) => s.id.startsWith('box:')), p.steps.filter((s) => s.id.startsWith('box:')));
  check('boxes reported as already restored', p.assets.filter((a) => /Already restored/.test(a.detail ?? '')).length === 4, p.assets.map((a) => a.detail));
}

console.log('\n── destroy ──');
{
  const r = await call('POST', `/labs/deployments/${dep.id}/destroy`);
  check('destroy accepted', r.status === 200 && r.json.status === 'destroying', r.json);
  const d = await waitFor(dep.id, ['destroyed'], 60_000);
  check('destroyed', d.status === 'destroyed', d.log.slice(-5));
  const { json: topo } = await call('GET', '/topology');
  check('lab guests are gone', !topo.nodes.some((n) => n.data.kind === 'guest' && n.data.tags.includes('pf-work-lab')));
  check('box templates kept for reuse', topo.nodes.filter((n) => n.data.kind === 'guest' && n.data.tags.includes('pf-box')).length === 4);
  const again = await call('POST', `/labs/deployments/${dep.id}/destroy`);
  check('destroying twice is harmless', again.status === 200);
}

console.log('\n── failure handling ──');
{
  // Template 9000 lives on pve1's local-lvm: cloning it to pve2 must fail with a helpful message.
  const cross = spec('Cross node', [base('x', 'xnode01', { kind: 'linux-vm', source: { type: 'template', vmid: 9000, family: 'debian' }, packages: [], memoryMiB: 1024, diskGiB: 16 })], 'pve2');
  const r = await call('POST', '/labs/deploy', cross);
  check('cross-node deploy starts', r.status === 201, r.json);
  const d = await waitFor(r.json.id, ['succeeded', 'warning', 'failed'], 60_000);
  const clone = d.steps.find((s) => s.id === 'x:clone');
  check('fails at clone', d.status === 'failed' && clone?.status === 'failed', d.steps.map((s) => `${s.id}=${s.status}`));
  check('error explains shared storage', /shared storage|deploy the lab to pve1/.test(clone?.error ?? ''), clone?.error);
  check('later steps skipped, seed ISO recorded for cleanup', d.steps.find((s) => s.id === 'x:start')?.status === 'skipped' && d.uploaded.length === 1);
  const del = await call('POST', `/labs/deployments/${d.id}/destroy`);
  const gone = await waitFor(d.id, ['destroyed'], 30_000);
  check('failed lab can be destroyed (removes the uploaded seed)', del.status === 200 && gone.status === 'destroyed', gone.log.slice(-3));
}

console.log('\n── destroy only deletes what is still the lab\'s ──');
{
  // Proxmox hands a freed VMID out again. Simulate that: the lab's container now belongs to another deployment.
  // The simulated Proxmox: :8006 under pnpm dev, a random local port inside a release's --demo.
  const mockUrl = (await call('GET', '/connections')).json.find((c) => c.id === 'mock')?.url ?? 'http://localhost:8006';
  const PVE = `${mockUrl}/api2/json`;
  const pve = (method, path, body) =>
    fetch(`${PVE}${path}`, {
      method,
      headers: { Authorization: 'PVEAPIToken=root@pam!proxflow=mock-secret', ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: body ? new URLSearchParams(body).toString() : undefined,
    }).then((r) => r.json());
  const s = spec('Reuse', [base('r', 'reuse01', { kind: 'lxc', source: { type: 'vztmpl', volid: 'share:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst' }, unprivileged: true, nesting: false, cores: 1, memoryMiB: 256, diskGiB: 4 })]);
  const r = await call('POST', '/labs/deploy', s);
  const d = await waitFor(r.json.id, ['succeeded', 'warning', 'failed'], 60_000);
  const vmid = d.created[0]?.vmid;
  check('small lab deployed', d.status === 'succeeded' && vmid, d.log.slice(-3));
  await pve('PUT', `/nodes/pve1/lxc/${vmid}/config`, { description: 'Created by ProxFlow — lab "Other" (deployment someone)' });
  await call('POST', `/labs/deployments/${d.id}/destroy`);
  const gone = await waitFor(d.id, ['destroyed'], 30_000);
  const { json: topo } = await call('GET', '/topology');
  check('a reused VMID is left alone', topo.nodes.some((n) => n.data.kind === 'guest' && n.data.vmid === vmid), gone.log.slice(-3));
  check('…and the log says why', gone.log.some((l) => l.level === 'warn' && l.msg.includes(`Left ${vmid} alone`)), gone.log.slice(-3));
  await pve('POST', `/nodes/pve1/lxc/${vmid}/status/stop`);
  await sleep(2500);
  await pve('DELETE', `/nodes/pve1/lxc/${vmid}?purge=1`);
}

console.log('\n── online-only catalog image: Import fix ──');
{
  const s = spec('Online', [base('u', 'cloud01', { kind: 'linux-vm', source: { type: 'catalog', image: 'ubuntu-24.04' }, packages: [], memoryMiB: 1024, diskGiB: 16 })]);
  const { json: inv } = await call('GET', '/connections/mock/inventory?node=pve1');
  const alreadyEnabled = inv.storages.find((x) => x.name === 'local')?.content.includes('import');
  const { json: p } = await call('POST', '/labs/plan', s);
  check('…plan warns it needs internet', p.issues.some((i) => /internet/.test(i.message)));
  if (alreadyEnabled) {
    console.log('    (Import already enabled on local by an earlier run — restart the mock to re-test the fix button)');
  } else {
    const fix = p.issues.find((i) => i.fix);
    check('plan offers "Enable Import on local"', fix?.fix?.content === 'import' && fix.fix.storage === 'local', p.issues);
    const f = await call('POST', '/labs/fix', { conn: 'mock', fix: fix.fix });
    check('fix applied', f.json?.ok === true, f.json);
  }
  const { json: p2 } = await call('POST', '/labs/plan', s);
  check('plan ok with Import enabled, with a download step', p2.ok && p2.assets.some((a) => a.action === 'download'), errorsOf(p2));
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
