// Tests the offline developer kit the way an air-gapped developer gets it: extracted with Windows' own tools into a
// folder with spaces, brackets and an ampersand, with no Node.js, pnpm or git on PATH, an empty user profile and
// every proxied request sent to a dead address. Then setup.cmd runs, and from the kit: typecheck, a release build,
// the dev servers and both smoke suites.
//
//   node scripts/dev-kit-smoke.mjs [release/proxflow-dev-windows-x64.zip]
//
// Needs ports 3001, 5180, 8006 and 8007 free (the dev servers' fixed ports).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32') throw new Error('The developer kit is for Windows');
const archive = resolve(process.argv[2] ?? join(ROOT, 'release', 'proxflow-dev-windows-x64.zip'));
if (!existsSync(archive)) throw new Error(`not found: ${archive} — build it with: node scripts/release.mjs --dev-kit`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${!ok && detail ? `\n      ${String(detail).slice(-1500).replace(/\n/g, '\n      ')}` : ''}`);
  return ok;
};
const portOpen = (port) =>
  new Promise((r) => {
    // "localhost": Vite listens on ::1 only, the API on every address; this tries both families.
    const s = connect({ port, host: 'localhost', autoSelectFamily: true }, () => (s.destroy(), r(true)));
    s.on('error', () => r(false));
  });

const busy = [];
for (const p of [3001, 5180, 8006, 8007]) if (await portOpen(p)) busy.push(p);
if (busy.length) throw new Error(`port(s) ${busy.join(', ')} already in use — stop the dev servers first`);

// ── 1. extract like a user would ──
const tmp = mkdtempSync(join(tmpdir(), 'proxflow dev & co ('));
const profile = join(tmp, 'profile');
console.log(`\n── extract to "${tmp}" ──`);
execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${tmp}'`], { stdio: 'inherit' });
const kit = join(tmp, readdirSync(tmp).find((f) => f.startsWith('proxflow-')));
const source = join(kit, 'source');
const info = JSON.parse(readFileSync(join(kit, 'kit.json'), 'utf8'));
check('kit extracted: setup, runtime, pnpm, store and source', ['setup.cmd', 'dev-shell.cmd', 'node/node.exe', 'node/pnpm.cmd', 'pnpm/bin/pnpm.cjs', 'store.tar.gz', 'source/package.json'].every((f) => existsSync(join(kit, f))));

// ── 2. an environment with nothing installed and no way out ──
const sys = process.env.SystemRoot ?? 'C:\\Windows';
const dead = 'http://127.0.0.1:9';
const env = {
  SystemRoot: sys,
  windir: sys,
  ComSpec: process.env.ComSpec ?? `${sys}\\System32\\cmd.exe`,
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  PATH: `${sys}\\System32;${sys};${sys}\\System32\\Wbem;${sys}\\System32\\WindowsPowerShell\\v1.0`,
  TEMP: tmp,
  TMP: tmp,
  USERPROFILE: profile,
  LOCALAPPDATA: join(profile, 'AppData', 'Local'),
  APPDATA: join(profile, 'AppData', 'Roaming'),
  USERNAME: process.env.USERNAME ?? 'user',
  // pnpm's registry requests hit a closed port. (Node's own fetch ignores these; the release build is checked
  // for downloads separately, and ProxFlow's probes must keep their real DNS and connection errors.)
  HTTP_PROXY: dead,
  HTTPS_PROXY: dead,
  NO_PROXY: 'localhost,127.0.0.1,::1',
};
const onPath = (exe, e) => spawnSync('where.exe', [exe], { env: e, stdio: 'ignore' }).status === 0;
check('no Node.js, pnpm or git on PATH', !onPath('node', env) && !onPath('pnpm', env) && !onPath('git', env));

const cmd = (line, { cwd = source, e = env, timeout = 600_000 } = {}) => {
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', line], { cwd, env: e, windowsVerbatimArguments: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
};

let dev;
try {
  // ── 3. setup.cmd, twice (the second run is what a moved kit gets) ──
  console.log('\n── setup.cmd ──');
  const t = Date.now();
  const setup = cmd(`""${join(kit, 'setup.cmd')}""`, { cwd: kit });
  for (const line of setup.out.split(/\r?\n/).filter((l) => l.startsWith('> '))) console.log(`    ${line.slice(2)}`);
  check(`setup.cmd finishes (${Math.round((Date.now() - t) / 1000)} s)`, setup.ok && setup.out.includes('Setup finished'), setup.out);
  check('…with the packages installed into source\\node_modules', existsSync(join(source, 'node_modules', '.modules.yaml')));
  check('…and a certificate for the simulated Proxmox', existsSync(join(source, 'apps', 'mock-pve', 'certs', 'cert.pem')));
  check('…without touching the user profile (no global pnpm store)', !existsSync(join(profile, 'AppData', 'Local', 'pnpm')));
  const again = cmd(`""${join(kit, 'setup.cmd')}""`, { cwd: kit });
  check('running setup.cmd again works', again.ok && again.out.includes('already unpacked'), again.out);

  // dev-shell.cmd ends in an interactive prompt; feed it a few commands the way a user would type them.
  const shell = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${join(kit, 'dev-shell.cmd')}""`], {
    cwd: tmp,
    env,
    windowsVerbatimArguments: true,
    encoding: 'utf8',
    input: 'node --version\r\npnpm --version\r\ncd\r\nexit\r\n',
    timeout: 60_000,
  });
  const shellOut = `${shell.stdout ?? ''}${shell.stderr ?? ''}`;
  check("dev-shell.cmd opens in source\\ with the kit's node and pnpm", shellOut.includes(`v${info.node}`) && shellOut.includes(info.pnpm) && shellOut.includes(`${source}\r\n`), shellOut);

  // ── 4. the dev shell's environment: the kit's node folder first on PATH ──
  const devEnv = { ...env, PATH: `${join(kit, 'node')};${env.PATH}` };
  const inKit = (line, timeout) => cmd(line, { e: devEnv, timeout });
  console.log('\n── tools from the kit ──');
  const nodeV = inKit('node --version');
  check(`node is the kit's ${info.node}`, nodeV.out.trim() === `v${info.node}`, nodeV.out);
  const pnpmV = inKit('pnpm --version');
  check(`pnpm is the kit's ${info.pnpm}`, pnpmV.out.trim() === info.pnpm, pnpmV.out);

  console.log('\n── pnpm typecheck ──');
  const tc = inKit('pnpm typecheck');
  check('typecheck passes', tc.ok, tc.out);

  console.log('\n── pnpm release ──');
  const rel = inKit('pnpm release');
  check('release build passes', rel.ok && existsSync(join(source, 'release', 'proxflow-windows-x64.zip')), rel.out);
  check('…with the Node.js runtime from the kit, nothing downloaded', rel.out.includes('matches the official checksum') && !rel.out.includes('downloading'), rel.out);

  // ── 5. pnpm dev + both smoke suites ──
  console.log('\n── pnpm dev ──');
  dev = spawn('cmd.exe', ['/d', '/s', '/c', 'pnpm dev'], { cwd: source, env: devEnv, windowsVerbatimArguments: true });
  let devOut = '';
  dev.stdout.on('data', (d) => (devOut += d));
  dev.stderr.on('data', (d) => (devOut += d));
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await sleep(1000);
    up = (await fetch('http://localhost:3001/api/health').then((r) => r.ok, () => false)) && (await portOpen(5180)) && (await portOpen(8007));
  }
  if (check('mock (:8006 + https :8007), API (:3001) and web (:5180) come up', up, devOut)) {
    const html = await fetch('http://localhost:5180/').then((r) => r.text(), (e) => String(e));
    check('Vite serves the app', html.includes('<div id="root">'), html.slice(0, 300));
    const main = await fetch('http://localhost:5180/src/main.tsx');
    check('…and compiles it (React plugin)', main.ok && (await main.text()).includes('import'), main.status);
    const css = await fetch('http://localhost:5180/src/index.css?direct');
    check('…and its Tailwind CSS', css.ok && (await css.text()).includes('--'), css.status);
    const viaProxy = await fetch('http://localhost:5180/api/connections').then((r) => r.json(), () => null);
    check('…with /api proxied to the server and the mock pre-connected', Array.isArray(viaProxy) && viaProxy.some((c) => c.id === 'mock'), JSON.stringify(viaProxy));

    console.log('\n── pnpm smoke ──');
    const smoke = inKit('pnpm smoke');
    check('connection suite passes', smoke.ok, smoke.out);
    console.log('\n── pnpm smoke:build ──');
    const build = inKit('pnpm smoke:build');
    check('lab-builder suite passes', build.ok, build.out);
  }
} finally {
  if (dev?.pid) {
    try {
      execFileSync('taskkill', ['/pid', String(dev.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {}
  }
  await sleep(1500);
  for (let i = 0; i < 8; i++) {
    try {
      rmSync(tmp, { recursive: true, force: true });
      break;
    } catch {
      await sleep(1000);
    }
  }
}

console.log(failures ? `\n${failures} developer kit check(s) FAILED` : '\ndeveloper kit OK');
process.exit(failures ? 1 : 0);
