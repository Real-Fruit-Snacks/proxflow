// Builds self-contained release packages: the web UI, the server bundled into one file, and the
// official Node.js runtime. The result runs with no installation and no internet.
//
//   node scripts/release.mjs [--targets windows-x64[,linux-x64]] [--skip-web] [--dev-kit]
//
// Output: release/proxflow-<target>.(zip|tar.gz) (holding a proxflow-<version>-<target> folder) and release/SHA256SUMS.txt
// --dev-kit adds release/proxflow-dev-windows-x64.zip: source, Node.js, pnpm and every package, for developing offline.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { unzipSync, zipSync } from 'fflate';
import { buildDevKit } from './lib/dev-kit.mjs';
import { linuxFiles, windowsFiles } from './lib/package-files.mjs';
import { createTarGz, extractFromTarGz } from './lib/tar.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NODE_VERSION = '24.22.2'; // bundled runtime (LTS)
const OUT = join(ROOT, 'release');
const CACHE = join(ROOT, '.cache');

// loose: the bare binary as listed in Node's SHASUMS256.txt. A copy at .cache/node/<loose> (the developer kit
// puts one there) is used instead of downloading the whole archive.
const TARGETS = {
  'windows-x64': { archive: `node-v${NODE_VERSION}-win-x64.zip`, bin: 'node.exe', format: 'zip', loose: 'win-x64/node.exe' },
  'linux-x64': { archive: `node-v${NODE_VERSION}-linux-x64.tar.gz`, bin: 'bin/node', format: 'tar.gz' },
};

const { values: args } = parseArgs({
  options: { targets: { type: 'string' }, 'skip-web': { type: 'boolean', default: false }, 'dev-kit': { type: 'boolean', default: false } },
});
// Windows is the release target; linux-x64 can still be built with --targets linux-x64.
const targets = (args.targets ?? 'windows-x64').split(',').map((t) => t.trim());
for (const t of targets) if (!TARGETS[t]) throw new Error(`Unknown target "${t}" (have: ${Object.keys(TARGETS).join(', ')})`);

const started = Date.now();
const step = (msg) => console.log(`\n▸ ${msg}  (${Math.round((Date.now() - started) / 1000)} s)`);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
// File times inside the packages: SOURCE_DATE_EPOCH, else the last commit, so the same commit builds the same bytes.
const commitTime = () => {
  try {
    return Number(execSync('git log -1 --format=%ct', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim());
  } catch {
    return NaN;
  }
};
const mtime = Number(process.env.SOURCE_DATE_EPOCH) || commitTime() || Math.floor(Date.now() / 1000);
// Zip entries hold local wall-clock time; shift it so they read as UTC whatever the build machine's time zone.
const zipTime = new Date(mtime * 1000 + new Date(mtime * 1000).getTimezoneOffset() * 60_000);

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// ───────────────────────── 1. web UI ─────────────────────────
const webDist = join(ROOT, 'apps/web/dist');
if (!args['skip-web']) {
  step('Building the web UI');
  execSync('pnpm --filter @proxflow/web build', { cwd: ROOT, stdio: 'inherit' });
}
if (!existsSync(join(webDist, 'index.html'))) throw new Error('apps/web/dist is missing — run without --skip-web');
const webFiles = walk(webDist).map((p) => ({ rel: relative(webDist, p).split('\\').join('/'), data: readFileSync(p) }));
// The release must work offline: refuse to ship a UI that pulls anything from the internet.
for (const f of webFiles.filter((x) => /\.(html|css)$/.test(x.rel))) {
  const ext = /(?:src|href)=["'](https?:)?\/\/|@import\s+url\(["']?https?:|url\(["']?https?:\/\//i.exec(f.data.toString());
  if (ext) throw new Error(`${f.rel} references an external URL (${ext[0]}) — the release must work offline`);
}

// ───────────────────────── 2. server bundle ─────────────────────────
step('Bundling the server');
const bundle = await build({
  entryPoints: [join(ROOT, 'apps/server/src/release.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  write: false,
  outfile: 'proxflow.mjs',
  // Bundled CommonJS packages (express…) call require(); give ESM output a real one.
  banner: { js: "import { createRequire as __pfCreateRequire } from 'node:module';\nconst require = __pfCreateRequire(import.meta.url);" },
  define: { __PROXFLOW_VERSION__: JSON.stringify(VERSION) },
  legalComments: 'none',
  logLevel: 'warning',
  metafile: true,
});
const serverJs = Buffer.from(bundle.outputFiles[0].contents);
// Everything must be inside the bundle: the only imports left may be Node.js built-ins.
const { builtinModules } = await import('node:module');
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const leftovers = Object.values(bundle.metafile.outputs)
  .flatMap((o) => o.imports)
  .filter((i) => i.external && !builtins.has(i.path) && !i.path.startsWith('node:'))
  .map((i) => i.path);
if (leftovers.length) throw new Error(`The server bundle still imports packages from outside: ${[...new Set(leftovers)].join(', ')}`);
const externalBuiltins = [...new Set(Object.values(bundle.metafile.outputs).flatMap((o) => o.imports).filter((i) => i.external).map((i) => i.path))];
console.log(`  only Node.js built-ins left outside the bundle (${externalBuiltins.length}): ${externalBuiltins.join(', ')}`);
const bundledPackages = new Set(
  Object.keys(bundle.metafile.inputs)
    .map((p) => /node_modules[\\/](?:\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(p)?.[1]?.replace('\\', '/'))
    .filter(Boolean),
);
console.log(`  proxflow.mjs: ${(serverJs.length / 1024).toFixed(0)} KiB, ${bundledPackages.size} npm packages inlined`);

// ───────────────────────── 3. third-party notices ─────────────────────────
step('Collecting third-party licenses');
/** License texts of the packages ProxFlow uses: only what ships in the app (prod), or everything (the dev kit). */
function thirdPartyNotices(prod) {
  const report = JSON.parse(execSync(`pnpm licenses list${prod ? ' --prod' : ''} --json`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  const out = [];
  const seen = new Set();
  for (const p of Object.values(report).flat().sort((a, b) => a.name.localeCompare(b.name))) {
    if (p.name.startsWith('@proxflow/') || seen.has(p.name)) continue;
    seen.add(p.name);
    const dir = p.paths?.[0];
    const file = dir && existsSync(dir) ? readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f)) : undefined;
    const text = file ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${p.license}${p.homepage ? ` — ${p.homepage}` : ''}`;
    out.push('-'.repeat(78), `${p.name} ${p.versions.join(', ')} (${p.license})`, '', text, '');
  }
  return { text: out.join('\n'), count: seen.size };
}
const prodNotices = thirdPartyNotices(true);
const noticesTxt = [
  `ProxFlow ${VERSION} includes the following third-party software.`,
  `Node.js ${NODE_VERSION} is included in the node folder; its license is in node/LICENSE.`,
  '',
  prodNotices.text,
].join('\n');
console.log(`  ${prodNotices.count} packages`);

// ───────────────────────── 4. Node.js runtime ─────────────────────────
/** Downloads url into .cache/<cacheName> once; later builds (and offline ones) reuse the cached copy. */
async function fetchCached(url, cacheName) {
  const file = join(CACHE, cacheName);
  if (existsSync(file)) return readFileSync(file);
  mkdirSync(dirname(file), { recursive: true });
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(`${file}.tmp`, buf); // a download cut short never lands in the cache
  renameSync(`${file}.tmp`, file);
  return buf;
}
const forget = (cacheName) => rmSync(join(CACHE, cacheName), { force: true });
const download = (name) => fetchCached(`https://nodejs.org/dist/v${NODE_VERSION}/${name}`, `node/${name}`);

async function nodeRuntime(target) {
  const t = TARGETS[target];
  const sums = (await download('SHASUMS256.txt')).toString();
  const official = (name) => new RegExp(`^([0-9a-f]{64})\\s+${name.replace(/\./g, '\\.')}$`, 'm').exec(sums)?.[1];
  const loose = t.loose && join(CACHE, 'node', ...t.loose.split('/'));
  if (loose && existsSync(loose) && existsSync(join(dirname(loose), 'LICENSE'))) {
    const bin = readFileSync(loose);
    if (sha256(bin) !== official(t.loose)) throw new Error(`${loose} doesn't match Node.js's official checksum — delete it and run again`);
    console.log(`  using ${relative(ROOT, loose)} (matches the official checksum)`);
    return { bin, license: readFileSync(join(dirname(loose), 'LICENSE')) };
  }
  const want = official(t.archive);
  const archive = await download(t.archive);
  if (!want || sha256(archive) !== want) {
    // Either file could be the bad one (a proxy's error page, a cut-off download): drop both.
    forget(`node/${t.archive}`);
    forget('node/SHASUMS256.txt');
    throw new Error(`Checksum mismatch for ${t.archive} — deleted the cached copies, run again`);
  }
  const base = t.archive.replace(/\.(zip|tar\.gz)$/, '');
  const names = [`${base}/${t.bin}`, `${base}/LICENSE`];
  const files = t.format === 'zip' ? new Map(Object.entries(unzipSync(archive, { filter: (f) => names.includes(f.name) }))) : extractFromTarGz(archive, names);
  for (const n of names) if (!files.has(n)) throw new Error(`${n} not found in ${t.archive}`);
  return { bin: Buffer.from(files.get(names[0])), license: Buffer.from(files.get(names[1])) };
}

// ───────────────────────── 5. packages ─────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const setupPs1 = readFileSync(join(ROOT, 'apps/server/src/build/payloads/windows-setup.ps1'));
const artifacts = [];

for (const target of targets) {
  step(`Packaging ${target}`);
  const runtime = await nodeRuntime(target);
  const top = `proxflow-${VERSION}-${target}`;
  const win = target.startsWith('windows');
  const entries = [
    { path: 'app/proxflow.mjs', data: serverJs },
    { path: 'app/windows-setup.ps1', data: setupPs1 },
    ...webFiles.map((f) => ({ path: `app/web/${f.rel}`, data: f.data })),
    { path: 'THIRD-PARTY-NOTICES.txt', data: Buffer.from(win ? noticesTxt.replace(/\r?\n/g, '\r\n') : noticesTxt) },
    { path: 'node/LICENSE', data: runtime.license },
    { path: win ? 'node/node.exe' : 'node/bin/node', data: runtime.bin, mode: 0o755 },
    { path: 'data/.keep', data: Buffer.alloc(0) },
    ...Object.entries(win ? windowsFiles(VERSION) : linuxFiles(VERSION)).map(([path, text]) => ({ path, data: Buffer.from(text), mode: path.endsWith('.sh') ? 0o755 : 0o644 })),
  ];
  // Version-free file name so releases/latest/download/<name> is a permanent link; the folder inside is versioned.
  const name = `proxflow-${target}.${TARGETS[target].format}`;
  const buf =
    TARGETS[target].format === 'zip'
      ? Buffer.from(zipSync(Object.fromEntries(entries.map((e) => [`${top}/${e.path}`, [new Uint8Array(e.data), { level: 9, mtime: zipTime }]]))))
      : createTarGz(entries.map((e) => ({ ...e, path: `${top}/${e.path}` })), { mtime });
  writeFileSync(join(OUT, name), buf);
  artifacts.push({ name, buf });
  console.log(`  ${name}: ${(buf.length / 1024 ** 2).toFixed(1)} MiB`);
}

// ───────────────────────── 6. offline developer kit ─────────────────────────
if (args['dev-kit']) {
  step('Building the offline developer kit');
  const kit = await buildDevKit({
    root: ROOT,
    version: VERSION,
    nodeVersion: NODE_VERSION,
    runtime: await nodeRuntime('windows-x64'),
    shasums: await download('SHASUMS256.txt'),
    notices: thirdPartyNotices,
    fetchCached,
    forget,
    zipTime,
    mtime,
  });
  writeFileSync(join(OUT, kit.name), kit.buf);
  artifacts.push(kit);
  console.log(`  ${kit.name}: ${(kit.buf.length / 1024 ** 2).toFixed(1)} MiB`);
}

const sums = artifacts.map((a) => `${sha256(a.buf)}  ${a.name}`).join('\n') + '\n';
writeFileSync(join(OUT, 'SHA256SUMS.txt'), sums);
// GitHub release body: RELEASE_NOTES.md + checksums.
const notesSrc = join(ROOT, 'RELEASE_NOTES.md');
if (existsSync(notesSrc)) {
  const notes = readFileSync(notesSrc, 'utf8').replaceAll('{{version}}', VERSION).replaceAll('{{node}}', NODE_VERSION);
  writeFileSync(join(OUT, 'notes.md'), `${notes.trimEnd()}\n\n### SHA-256\n\n\`\`\`\n${sums}\`\`\`\n`);
}
step(`Done — ${OUT}`);
