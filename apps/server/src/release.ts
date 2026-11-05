/**
 * Release entry: bundled to app/proxflow.mjs and run by the bundled Node.js via ProxFlow.cmd / proxflow.sh.
 * Serves the web UI and the API on one port. Needs no internet and nothing installed.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { startServer, type RunningServer, type ServerOptions } from './app.js';
import { envConnection } from './env.js';
import { readJsonFile, writeJsonFile } from './json-file.js';

declare const __PROXFLOW_VERSION__: string | undefined;
const VERSION = typeof __PROXFLOW_VERSION__ !== 'undefined' ? __PROXFLOW_VERSION__ : 'dev';
const DEFAULT_PORT = 3001;

const here = dirname(fileURLToPath(import.meta.url)); // <install>/app in the release
const root = resolve(here, '..');

const HELP = `ProxFlow ${VERSION} — Proxmox map and lab builder

Usage: ProxFlow.cmd [options]        (Windows)
       ./proxflow.sh [options]       (Linux)

Options:
  --port <n>       Port to serve on (default ${DEFAULT_PORT}; the next free one is used if it's busy)
  --host <addr>    Address to listen on (default: all network interfaces)
  --data-dir <p>   Where connections and lab history are kept (default: <install folder>/data)
  --demo           Use a built-in simulated Proxmox — try everything without a real host
  --no-open        Don't open the browser
  -v, --version    Print the version
  -h, --help       Show this help

Headless setup (optional): set PVE_URL plus PVE_TOKEN_ID/PVE_TOKEN_SECRET (or PVE_USERNAME/PVE_PASSWORD)
and optionally PVE_FINGERPRINT to add a connection without using the UI.
`;

function fail(msg: string): never {
  console.error(`\nProxFlow couldn't start: ${msg}\n`);
  process.exit(1);
}

function parse() {
  try {
    return parseArgs({
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        'data-dir': { type: 'string' },
        demo: { type: 'boolean', default: false },
        'no-open': { type: 'boolean', default: false },
        version: { type: 'boolean', short: 'v', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    }).values;
  } catch (e) {
    fail(`${e instanceof Error ? e.message : e}\n\n${HELP}`);
  }
}

/** The built UI: next to the bundle in a release, apps/web/dist when run from source. */
function findWebDir(): string {
  const candidates = [process.env.PROXFLOW_WEB_DIR, resolve(here, 'web'), resolve(here, '../../web/dist')].filter((p): p is string => Boolean(p));
  const found = candidates.find((p) => existsSync(resolve(p, 'index.html')));
  if (!found) fail(`the web UI is missing (looked in ${candidates.join(', ')}). Re-extract the release.`);
  return found;
}

function openBrowser(url: string) {
  try {
    const p =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '""', `"${url}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
        : process.platform === 'darwin'
          ? spawn('open', [url], { detached: true, stdio: 'ignore' })
          : process.env.DISPLAY || process.env.WAYLAND_DISPLAY
            ? spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
            : undefined;
    p?.on('error', () => {});
    p?.unref();
  } catch {
    /* no browser — the URL is printed anyway */
  }
}

/** mkdir -p plus a real write test (a folder can exist yet be read-only). */
function ensureWritable(dir: string) {
  mkdirSync(dir, { recursive: true });
  const probe = resolve(dir, `.write-test-${process.pid}`);
  writeFileSync(probe, '');
  rmSync(probe, { force: true });
}

function forgetDemoHistory(dir: string) {
  const deployments = resolve(dir, 'deployments.json');
  const d = readJsonFile<{ deployments?: { conn?: string }[] }>(deployments);
  if (d?.deployments) writeJsonFile(deployments, { ...d, deployments: d.deployments.filter((x) => x.conn !== 'mock') });
  const boxes = resolve(dir, 'boxes.json');
  const b = readJsonFile<{ boxes?: { conn?: string }[] }>(boxes);
  if (b?.boxes) writeJsonFile(boxes, { ...b, boxes: b.boxes.filter((x) => x.conn !== 'mock') });
}

const lanAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => Boolean(a) && a!.family === 'IPv4' && !a!.internal)
    .map((a) => a.address);

async function main() {
  const args = parse();
  if (args.help) return void console.log(HELP);
  if (args.version) return void console.log(VERSION);

  const explicitPort = args.port !== undefined;
  const rawPort = args.port ?? process.env.PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail(`"${rawPort}" isn't a valid port number${explicitPort ? '' : ' (from the PORT environment variable)'}.`);
  }

  const chosen = args['data-dir'] ?? process.env.PROXFLOW_DATA_DIR;
  // Demo history lives apart from real connections and labs.
  const withDemo = (d: string) => (args.demo ? resolve(d, 'demo') : resolve(d));
  let dataDir = withDemo(chosen ?? resolve(root, 'data'));
  let fallbackNote = '';
  try {
    ensureWritable(dataDir);
  } catch (e) {
    // Extracted somewhere read-only (e.g. C:\Program Files)? Keep data in the user's profile instead.
    const profile = process.env.LOCALAPPDATA ?? (process.env.HOME ? resolve(process.env.HOME, '.local/share') : undefined);
    if (chosen || !profile) fail(`can't write to the data folder ${dataDir} (${e instanceof Error ? e.message : e}). Use --data-dir to pick another one.`);
    const alt = withDemo(resolve(profile, 'ProxFlow', 'data'));
    try {
      ensureWritable(alt);
    } catch (e2) {
      fail(`can't write to ${dataDir} or ${alt} (${e2 instanceof Error ? e2.message : e2}). Use --data-dir to pick a folder you can write to.`);
    }
    fallbackNote = `  (the install folder isn't writable, so data is kept in your profile)`;
    dataDir = alt;
  }

  const seeds: NonNullable<ServerOptions['seeds']> = [];
  if (args.demo) {
    // The simulated Proxmox starts empty every time, so labs and boxes from an earlier demo run no longer
    // exist and their VMIDs will be handed out again. Forget them (labs on real connections are kept).
    forgetDemoHistory(dataDir);
    const { startMock } = await import('@proxflow/mock-pve');
    const mock = await startMock({ port: 0, host: '127.0.0.1' });
    seeds.push({
      id: 'mock',
      name: 'Demo (simulated Proxmox)',
      url: `http://127.0.0.1:${mock.port}`,
      auth: { type: 'token', tokenId: 'root@pam!proxflow', secret: 'mock-secret' },
      tls: { mode: 'system' },
    });
  }
  const env = envConnection();
  if (env) seeds.push({ id: 'env', ...env });

  const webDir = findWebDir();
  let server: RunningServer | undefined;
  for (let p = port; !server; p++) {
    try {
      server = await startServer({ port: p, host: args.host, dataDir, webDir, seeds });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'EADDRINUSE' && !explicitPort && p < port + 20) continue;
      if (code === 'EADDRINUSE') fail(`port ${p} is already in use. Start with --port <another port>.`);
      if (code === 'EACCES') fail(`not allowed to use port ${p}. Pick one above 1024 with --port.`);
      if (code === 'EADDRNOTAVAIL') fail(`${args.host} isn't an address of this machine.`);
      throw e;
    }
  }

  // Listening on one specific address: that's the only one that works, so open and print it.
  const wildcard = !args.host || args.host === '0.0.0.0' || args.host === '::';
  const shown = wildcard ? 'localhost' : isIP(args.host!) === 6 ? `[${args.host}]` : args.host!;
  const local = `http://${shown}:${server.port}`;
  const others = wildcard ? lanAddresses().map((a) => `http://${a}:${server!.port}`) : [];
  console.log(`\n  ProxFlow ${VERSION}${args.demo ? '  —  DEMO MODE (simulated Proxmox, nothing real is touched)' : ''}\n`);
  console.log(`  Open:   ${local}`);
  if (others.length) console.log(`          ${others.join('\n          ')}`);
  console.log(`  Data:   ${dataDir}`);
  if (fallbackNote) console.log(fallbackNote);
  if (server.port !== port) console.log(`  (port ${port} was busy, so ${server.port} is used)`);
  console.log('\n  Leave this window open while you use ProxFlow. Press Ctrl+C to stop.\n');

  if (!args['no-open']) openBrowser(local);

  const stop = () => {
    console.log('\n  Stopping ProxFlow…');
    void server!.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => fail(e instanceof Error ? (e.stack ?? e.message) : String(e)));
