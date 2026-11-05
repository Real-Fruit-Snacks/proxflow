// Builds self-contained release packages: the web UI, the server bundled into one file, and the
// official Node.js runtime. The result runs with no installation and no internet.
//
//   node scripts/release.mjs [--targets windows-x64[,linux-x64]] [--skip-web]
//
// Output: release/proxflow-<target>.(zip|tar.gz) (holding a proxflow-<version>-<target> folder) and release/SHA256SUMS.txt
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { unzipSync, zipSync } from 'fflate';
import { linuxFiles, windowsFiles } from './lib/package-files.mjs';
import { createTarGz, extractFromTarGz } from './lib/tar.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const NODE_VERSION = '24.22.2'; // bundled runtime (LTS)
const OUT = join(ROOT, 'release');
const CACHE = join(ROOT, '.cache', 'node');

const TARGETS = {
  'windows-x64': { archive: `node-v${NODE_VERSION}-win-x64.zip`, bin: 'node.exe', format: 'zip' },
  'linux-x64': { archive: `node-v${NODE_VERSION}-linux-x64.tar.gz`, bin: 'bin/node', format: 'tar.gz' },
};

const { values: args } = parseArgs({ options: { targets: { type: 'string' }, 'skip-web': { type: 'boolean', default: false } } });
// Windows is the release target; linux-x64 can still be built with --targets linux-x64.
const targets = (args.targets ?? 'windows-x64').split(',').map((t) => t.trim());
for (const t of targets) if (!TARGETS[t]) throw new Error(`Unknown target "${t}" (have: ${Object.keys(TARGETS).join(', ')})`);

const step = (msg) => console.log(`\n▸ ${msg}`);
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const mtime = process.env.SOURCE_DATE_EPOCH ? Number(process.env.SOURCE_DATE_EPOCH) : Math.floor(Date.now() / 1000);

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
const licenseReport = JSON.parse(execSync('pnpm licenses list --prod --json', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const notices = [
  `ProxFlow ${VERSION} includes the following third-party software.`,
  `Node.js ${NODE_VERSION} is included in the node folder; its license is in node/LICENSE.`,
  '',
];
const seen = new Set();
for (const p of Object.values(licenseReport).flat().sort((a, b) => a.name.localeCompare(b.name))) {
  if (p.name.startsWith('@proxflow/') || seen.has(p.name)) continue;
  seen.add(p.name);
  const dir = p.paths?.[0];
  const file = dir && existsSync(dir) ? readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f)) : undefined;
  const text = file ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${p.license}${p.homepage ? ` — ${p.homepage}` : ''}`;
  notices.push('-'.repeat(78), `${p.name} ${p.versions.join(', ')} (${p.license})`, '', text, '');
}
const noticesTxt = notices.join('\n');
console.log(`  ${seen.size} packages`);

// ───────────────────────── 4. Node.js runtime ─────────────────────────
async function download(name) {
  mkdirSync(CACHE, { recursive: true });
  const file = join(CACHE, name);
  if (existsSync(file)) return readFileSync(file);
  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${name}`;
  console.log(`  downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(file, buf);
  return buf;
}

async function nodeRuntime(target) {
  const t = TARGETS[target];
  const sums = (await download('SHASUMS256.txt')).toString();
  const want = new RegExp(`^([0-9a-f]{64})\\s+${t.archive.replace(/\./g, '\\.')}$`, 'm').exec(sums)?.[1];
  const archive = await download(t.archive);
  if (!want || sha256(archive) !== want) {
    rmSync(join(CACHE, t.archive), { force: true });
    throw new Error(`Checksum mismatch for ${t.archive} — deleted the cached copy, run again`);
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
      ? Buffer.from(zipSync(Object.fromEntries(entries.map((e) => [`${top}/${e.path}`, [new Uint8Array(e.data), { level: 9, mtime: mtime * 1000 }]]))))
      : createTarGz(entries.map((e) => ({ ...e, path: `${top}/${e.path}` })), { mtime });
  writeFileSync(join(OUT, name), buf);
  artifacts.push({ name, buf });
  console.log(`  ${name}: ${(buf.length / 1024 ** 2).toFixed(1)} MiB`);
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
