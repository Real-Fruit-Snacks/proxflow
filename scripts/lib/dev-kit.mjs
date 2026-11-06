// The offline developer kit (proxflow-dev-windows-x64.zip): the source, the Node.js runtime, pnpm and a pnpm
// store holding every package in pnpm-lock.yaml, so ProxFlow can be developed, tested and released on a Windows
// computer with no internet. Built by `node scripts/release.mjs --dev-kit`; scripts/dev-kit-setup.mjs sets it up.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { zipSync } from 'fflate';
import { devKitFiles } from './package-files.mjs';
import { createTarGz, readTarGz } from './tar.mjs';

const walk = (dir) =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const posix = (p) => p.split('\\').join('/');

/**
 * @param {object} o
 * @param {string} o.root           repository root
 * @param {(url: string, cacheName: string) => Promise<Buffer>} o.fetchCached  download into .cache/, reused offline
 * @param {(cacheName: string) => void} o.forget  drop a cached download
 * @param {{ bin: Buffer, license: Buffer }} o.runtime  the verified Windows node.exe and its LICENSE
 * @param {Buffer} o.shasums        Node.js SHASUMS256.txt, so `pnpm release` in the kit can check node.exe
 * @param {(prod: boolean) => { text: string, count: number }} o.notices  third-party license text
 */
export async function buildDevKit({ root, version, nodeVersion, runtime, shasums, notices, fetchCached, forget, zipTime, mtime }) {
  const t0 = Date.now();
  const took = () => `${Math.round((Date.now() - t0) / 1000)} s`;
  const pnpmVersion = /^pnpm@(\d+\.\d+\.\d+)$/.exec(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).packageManager ?? '')?.[1];
  // pnpm switches to the packageManager version on its own, which would need the internet: ship exactly that one.
  if (!pnpmVersion) throw new Error('package.json needs "packageManager": "pnpm@<x.y.z>"');

  // ── pnpm, checked against the registry's integrity hash ──
  const metaName = `pnpm/pnpm-${pnpmVersion}.json`;
  const tgzName = `pnpm/pnpm-${pnpmVersion}.tgz`;
  const meta = JSON.parse((await fetchCached(`https://registry.npmjs.org/pnpm/${pnpmVersion}`, metaName)).toString());
  const tgz = await fetchCached(meta.dist.tarball, tgzName);
  const [algo, want] = [meta.dist.integrity.slice(0, meta.dist.integrity.indexOf('-')), meta.dist.integrity.slice(meta.dist.integrity.indexOf('-') + 1)];
  if (createHash(algo).update(tgz).digest('base64') !== want) {
    forget(metaName);
    forget(tgzName);
    throw new Error(`pnpm ${pnpmVersion} doesn't match its registry checksum — deleted the cached copies, run again`);
  }
  const pnpmFiles = [...readTarGz(tgz)]
    .filter((e) => e.type === '0' && e.name.startsWith('package/'))
    .map((e) => ({ path: `pnpm/${e.name.slice('package/'.length)}`, data: Buffer.from(e.data) }));
  console.log(`  pnpm ${pnpmVersion}: ${pnpmFiles.length} files (${took()})`);

  // ── the package store: everything pnpm-lock.yaml lists, for Windows x64 ──
  const work = mkdtempSync(join(tmpdir(), 'proxflow-devkit-'));
  let storeTgz;
  let storeCount;
  try {
    for (const f of pnpmFiles) {
      mkdirSync(dirname(join(work, f.path)), { recursive: true });
      writeFileSync(join(work, f.path), f.data);
    }
    const project = join(work, 'project');
    for (const f of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', ...git(root, 'ls-files', '*/package.json')]) {
      mkdirSync(dirname(join(project, f)), { recursive: true });
      cpSync(join(root, f), join(project, f));
    }
    const store = join(work, 'store');
    // The kit's own pnpm fills a new, empty store, so the layout matches the pnpm that will read it.
    console.log(`  filling a new package store (${took()})`);
    execFileSync(process.execPath, [join(work, 'pnpm/bin/pnpm.cjs'), 'fetch', '--store-dir', store, '--reporter', 'append-only'], { cwd: project, stdio: ['ignore', 'inherit', 'inherit'] });
    // files/ and index/ are the store; projects/ (links back to whoever used it) and tmp/ are local bookkeeping.
    const files = walk(store)
      .map((p) => posix(relative(store, p)))
      .filter((p) => /^v\d+\/(files|index)\//.test(p));
    if (!files.some((p) => /\/index\//.test(p))) throw new Error(`pnpm fetch left an unexpected store layout in ${store}`);
    storeCount = files.length;
    console.log(`  packing ${storeCount} store files (${took()})`);
    storeTgz = createTarGz(files.map((p) => ({ path: p, data: readFileSync(join(store, p)) })), { mtime, level: 6 });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`  package store: ${storeCount} files, ${(storeTgz.length / 1024 ** 2).toFixed(1)} MiB packed (${took()})`);

  // ── the source: every file git tracks or would track (not ignored), as it is in the working tree ──
  const source = git(root, 'ls-files', '--cached', '--others', '--exclude-standard').filter((f) => existsSync(join(root, f)));
  const dirty = git(root, 'status', '--porcelain');
  if (dirty.length) console.log(`  note: ${dirty.length} uncommitted change(s) go into the kit's source`);

  const pnpmLicense = pnpmFiles.find((f) => /^pnpm\/licen[cs]e/i.test(f.path));
  const { text: depNotices, count } = notices(false);
  const noticesTxt = [
    `ProxFlow ${version} developer kit: third-party software.`,
    `Node.js ${nodeVersion} is in the node folder; its license is in node/LICENSE.`,
    '',
    '-'.repeat(78),
    `pnpm ${pnpmVersion} (MIT)`,
    '',
    pnpmLicense ? pnpmLicense.data.toString().trim() : 'License: MIT — https://github.com/pnpm/pnpm/blob/main/LICENSE',
    '',
    depNotices,
  ].join('\n');

  const top = `proxflow-${version}-dev-windows-x64`;
  const entries = [
    ...source.map((f) => ({ path: `source/${f}`, data: readFileSync(join(root, f)) })),
    { path: 'source/.cache/node/SHASUMS256.txt', data: shasums },
    { path: 'node/node.exe', data: runtime.bin },
    { path: 'node/LICENSE', data: runtime.license },
    ...pnpmFiles,
    { path: 'store.tar.gz', data: storeTgz, stored: true },
    { path: 'kit.json', data: Buffer.from(`${JSON.stringify({ version, node: nodeVersion, pnpm: pnpmVersion }, null, 2)}\n`) },
    { path: 'THIRD-PARTY-NOTICES.txt', data: Buffer.from(noticesTxt.replace(/\r?\n/g, '\r\n')) },
    ...Object.entries(devKitFiles(version, nodeVersion, pnpmVersion)).map(([path, text]) => ({ path, data: Buffer.from(text) })),
  ];
  // store.tar.gz is compressed already; zipping it again would only cost time.
  const buf = Buffer.from(
    zipSync(Object.fromEntries(entries.map((e) => [`${top}/${e.path}`, [new Uint8Array(e.data), { level: e.stored ? 0 : 9, mtime: zipTime }]]))),
  );
  console.log(`  ${source.length} source files, ${count} packages' licenses (${took()})`);
  return { name: 'proxflow-dev-windows-x64.zip', buf };
}

function git(root, command, ...args) {
  return execFileSync('git', ['-c', 'core.quotepath=off', command, '-z', ...args], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split('\0')
    .filter(Boolean);
}
