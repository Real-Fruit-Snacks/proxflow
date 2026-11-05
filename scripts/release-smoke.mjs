// Tests a release package exactly as a user would get it: extracted with the OS's own tools into a
// folder with spaces and brackets, started with a stripped-down PATH (no Node.js, pnpm or git), in
// demo mode — then the web UI is checked and the full lab-builder suite runs against it.
//
//   node scripts/release-smoke.mjs release/proxflow-<v>-windows-x64.zip [--port 3101] [--readonly-data]
//
// --readonly-data makes the package's data folder unwritable and checks the fallback data location.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: 'string', default: '3101' }, 'readonly-data': { type: 'boolean', default: false } } });
const WIN = process.platform === 'win32';
// Default: this platform's package in release/.
const archive = positionals[0]
  ? resolve(positionals[0])
  : join(ROOT, 'release', readdirSync(join(ROOT, 'release')).find((f) => f.endsWith(WIN ? '-windows-x64.zip' : '-linux-x64.tar.gz')) ?? 'missing');
if (!existsSync(archive)) throw new Error(`usage: release-smoke [archive]  (not found: ${archive})`);
const PORT = Number(opts.port);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${!ok && detail ? `\n      ${String(detail).slice(0, 800)}` : ''}`);
};

// ── 1. extract like a user would ──
const tmp = mkdtempSync(join(tmpdir(), 'proxflow smoke ('));
const profile = join(tmp, 'profile');
console.log(`\n── extract to "${tmp}" ──`);
if (WIN) execFileSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${tmp}'`], { stdio: 'inherit' });
else execFileSync('tar', ['-xzf', archive, '-C', tmp], { stdio: 'inherit' });
const top = readdirSync(tmp).find((f) => f.startsWith('proxflow-'));
const dir = join(tmp, top);
const launcher = join(dir, WIN ? 'ProxFlow.cmd' : 'proxflow.sh');
check('package extracted with launcher, runtime and app', existsSync(launcher) && existsSync(join(dir, WIN ? 'node/node.exe' : 'node/bin/node')) && existsSync(join(dir, 'app/proxflow.mjs')));

// ── 2. an environment with nothing installed ──
const sys = process.env.SystemRoot ?? 'C:\\Windows';
const env = WIN
  ? {
      SystemRoot: sys,
      windir: sys,
      ComSpec: process.env.ComSpec ?? `${sys}\\System32\\cmd.exe`,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      PATH: `${sys}\\System32;${sys};${sys}\\System32\\Wbem`,
      TEMP: tmp,
      TMP: tmp,
      USERPROFILE: profile,
      LOCALAPPDATA: join(profile, 'AppData', 'Local'),
      APPDATA: join(profile, 'AppData', 'Roaming'),
      USERNAME: process.env.USERNAME ?? 'user',
    }
  : { PATH: '/usr/bin:/bin', HOME: profile, TMPDIR: tmp };
let nodeOnPath = true;
try {
  execFileSync(WIN ? 'where.exe' : 'sh', WIN ? ['node'] : ['-c', 'command -v node'], { env, stdio: 'ignore' });
} catch {
  nodeOnPath = false;
}
check('no Node.js on PATH in the test environment', !nodeOnPath);

if (opts['readonly-data']) {
  if (WIN) execFileSync('icacls', [join(dir, 'data'), '/deny', `${process.env.USERNAME}:(OI)(CI)W`], { stdio: 'ignore' });
  else execFileSync('chmod', ['0555', join(dir, 'data')]);
}

// ── 3. start it ──
const args = ['--demo', '--no-open', '--port', String(PORT)];
const child = WIN
  ? spawn('cmd.exe', ['/d', '/s', '/c', `""${launcher}" ${args.join(' ')}"`], { env, cwd: tmp, windowsVerbatimArguments: true })
  : spawn(launcher, args, { env, cwd: tmp, detached: true });
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));
let exited = false;
child.on('exit', () => (exited = true));

const base = `http://localhost:${PORT}`;
let up = false;
for (let i = 0; i < 60 && !exited && !up; i++) {
  await sleep(500);
  up = await fetch(`${base}/api/health`).then((r) => r.ok, () => false);
}
check(`started from the package (${base})`, up, output || (exited ? 'process exited' : 'no output'));

try {
  if (up) {
    console.log('\n── web UI ──');
    const html = await fetch(base).then((r) => r.text());
    check('GET / serves the app', html.includes('<div id="root">'), html.slice(0, 200));
    const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    const js = asset ? await fetch(base + asset) : undefined;
    check('JS bundle is served', js?.ok && (js.headers.get('content-type') ?? '').includes('javascript'), asset);
    const deep = await fetch(`${base}/some/deep/link`).then((r) => r.text());
    check('unknown page falls back to the app', deep.includes('<div id="root">'));
    const api404 = await fetch(`${base}/api/does-not-exist`);
    check('unknown API path → JSON 404', api404.status === 404 && (await api404.json()).error === 'Not found');
    check('start banner shows the address and demo mode', /Open:\s+http:\/\/localhost:\d+/.test(output) && output.includes('DEMO MODE'), output);
    if (opts['readonly-data']) {
      check('read-only install folder → data kept in the profile', output.includes('ProxFlow') && output.includes(join(profile, 'AppData', 'Local')), output);
    }

    console.log('\n── full lab-builder suite against the package ──');
    const suite = spawn(process.execPath, [join(ROOT, 'apps/server/scripts/smoke-build.mjs'), `${base}/api`], { stdio: 'inherit' });
    const code = await new Promise((r) => suite.on('exit', r));
    check('lab-builder suite passed', code === 0);
  }
} finally {
  if (!exited) {
    if (WIN) {
      try {
        execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } catch {}
    } else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
    }
  }
  await sleep(1000);
  if (opts['readonly-data']) {
    try {
      if (WIN) execFileSync('icacls', [join(dir, 'data'), '/remove:d', process.env.USERNAME], { stdio: 'ignore' });
      else execFileSync('chmod', ['0755', join(dir, 'data')]);
    } catch {}
  }
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(tmp, { recursive: true, force: true });
      break;
    } catch {
      await sleep(1000);
    }
  }
}

console.log(failures ? `\n${failures} release check(s) FAILED` : '\nrelease package OK');
process.exit(failures ? 1 : 0);
