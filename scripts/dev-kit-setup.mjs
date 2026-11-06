// Sets up the offline developer kit (proxflow-dev-windows-x64.zip) after it has been extracted: unpacks the
// package store, installs every dependency from it with no network, and prepares what `pnpm release` and the
// simulated Proxmox need. setup.cmd in the kit runs this with the kit's own Node.js; safe to run again.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarGz } from './lib/tar.mjs';

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = resolve(SOURCE, '..');
const started = Date.now();
const step = (msg) => console.log(`\n> ${msg}  (${Math.round((Date.now() - started) / 1000)} s)`);
const fail = (msg) => {
  console.error(`\n${msg}`);
  process.exit(1);
};

if (!existsSync(join(KIT, 'kit.json')) || !existsSync(join(KIT, 'pnpm', 'bin', 'pnpm.cjs'))) {
  fail('This script sets up the ProxFlow developer kit (proxflow-dev-windows-x64.zip) and must run from its setup.cmd.');
}
const kit = JSON.parse(readFileSync(join(KIT, 'kit.json'), 'utf8'));
const NODE_DIR = join(KIT, 'node');
const STORE = join(KIT, 'store');
const PNPM = join(KIT, 'pnpm', 'bin', 'pnpm.cjs');
console.log(`ProxFlow ${kit.version} developer kit: Node.js ${kit.node}, pnpm ${kit.pnpm}\nin ${KIT}`);

// ── 1. the package store ──
if (existsSync(join(STORE, '.complete'))) {
  step('Package store already unpacked');
} else {
  step('Unpacking the package store (store.tar.gz)');
  const archive = join(KIT, 'store.tar.gz');
  if (!existsSync(archive)) fail(`${archive} is missing - extract the whole kit zip again.`);
  const partial = `${STORE}.partial`;
  rmSync(partial, { recursive: true, force: true });
  rmSync(STORE, { recursive: true, force: true });
  const made = new Set();
  let files = 0;
  for (const e of readTarGz(readFileSync(archive))) {
    if (e.type !== '0') continue;
    const target = resolve(partial, ...e.name.split('/'));
    if (!target.startsWith(partial + sep)) fail(`Refusing to unpack ${e.name}: it points outside the store.`);
    const dir = dirname(target);
    if (!made.has(dir)) {
      mkdirSync(dir, { recursive: true });
      made.add(dir);
    }
    writeFileSync(target, e.data);
    // Keep the archive's time, like any tar tool: pnpm re-hashes every store file that looks newer than its
    // last check, which turns a 5 s install into minutes.
    if (e.mtime) utimesSync(target, e.mtime, e.mtime);
    files++;
  }
  writeFileSync(join(partial, '.complete'), `${files} files\n`);
  renameSync(partial, STORE);
  console.log(`  ${files} files`);
}

// ── 2. pnpm settings: this kit's store, never the network ──
// Quoted, forward slashes: .npmrc treats an unquoted ; or # as the start of a comment.
step('Pointing pnpm at the kit (source\\.npmrc)');
writeFileSync(join(SOURCE, '.npmrc'), `# Written by the developer kit's setup.cmd\nstore-dir=${JSON.stringify(STORE.split(sep).join('/'))}\noffline=true\n`);

// ── 3. install ──
step('Installing the packages into source\\ (offline)');
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
const env = { ...process.env, [pathKey]: `${NODE_DIR};${process.env[pathKey] ?? ''}` };
// A moved kit leaves node_modules linked to the old store location: let pnpm rebuild it without asking.
const install = spawnSync(process.execPath, [PNPM, 'install', '--offline', '--frozen-lockfile', '--config.confirm-modules-purge=false'], {
  cwd: SOURCE,
  env,
  stdio: 'inherit',
});
if (install.status !== 0) fail('pnpm install failed - see above.');

// ── 4. what `pnpm release` needs: the Node.js runtime it packs, checked against the official SHASUMS256.txt ──
step('Preparing pnpm release (Node.js runtime in source\\.cache\\node)');
const cached = join(SOURCE, '.cache', 'node', 'win-x64');
mkdirSync(cached, { recursive: true });
for (const f of ['node.exe', 'LICENSE']) copyFileSync(join(NODE_DIR, f), join(cached, f));

// ── 5. the simulated Proxmox's self-signed certificate ──
step("Simulated Proxmox's HTTPS certificate");
const cert = spawnSync(process.execPath, [join(SOURCE, 'apps', 'mock-pve', 'scripts', 'gen-cert.mjs')], { cwd: SOURCE, env, stdio: 'inherit' });
if (cert.status !== 0) fail('Making the certificate failed - see above.');

console.log(`\nSetup finished in ${Math.round((Date.now() - started) / 1000)} s.`);
