/** The ProxFlow server as a startable component (dev: index.ts, release: release.ts). */
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { BoxCache } from './build/box-cache.js';
import { DeploymentManager } from './build/deployments.js';
import { createBuildRoutes } from './build/routes.js';
import { ConnectionManager, NotFoundError } from './connections/manager.js';
import { ConnectionStore } from './connections/store.js';
import type { SeedConnection } from './env.js';
import { PveError } from './pve/client.js';
import { HttpError, createRoutes } from './routes.js';

export type ServerOptions = {
  port: number;
  host?: string;
  dataDir: string;
  topologyCacheMs?: number;
  /** Built web UI (index.html + assets). When set, the server is the whole app on one port. */
  webDir?: string;
  /** In-memory connections for this run only (mock / environment). */
  seeds?: (SeedConnection & { id: string })[];
};

export type RunningServer = { port: number; close(): Promise<void>; connections(): { name: string; url: string }[]; dataDir: string };

export function createApp(o: ServerOptions) {
  const store = new ConnectionStore(resolve(o.dataDir, 'connections.json'));
  const manager = new ConnectionManager(store, o.topologyCacheMs ?? 2000);
  const deployments = new DeploymentManager(resolve(o.dataDir, 'deployments.json'), (conn) => manager.invalidate(conn));
  const boxCache = new BoxCache(resolve(o.dataDir, 'boxes.json'));
  for (const s of o.seeds ?? []) manager.seed(s);

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  // Changes must come as JSON. A web page on another site can only send that after a CORS preflight, which
  // ProxFlow never approves, so it can't start, stop or delete anything through someone's browser.
  app.use('/api', (req, res, next) => {
    // (Read the header itself: req.is() answers null for requests without a body, like power actions.)
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' || type === 'application/json') return next();
    res.status(415).json({ error: 'Send requests that change something with Content-Type: application/json', status: 415 });
  });
  app.use('/api', createRoutes(manager));
  app.use('/api', createBuildRoutes(manager, deployments, boxCache));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found', status: 404 }));

  if (o.webDir) {
    const index = resolve(o.webDir, 'index.html');
    if (!existsSync(index)) throw new Error(`Web UI not found at ${o.webDir}`);
    app.use(express.static(o.webDir, { index: 'index.html', maxAge: '1h', setHeaders: (res, path) => path.endsWith('index.html') && res.setHeader('Cache-Control', 'no-cache') }));
    // Single-page app: any other GET shows the UI.
    app.use((req, res, next) => (req.method === 'GET' ? res.setHeader('Cache-Control', 'no-cache').sendFile(index) : next()));
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError || err instanceof NotFoundError) {
      res.status(err.status).json({ error: err.message, status: err.status });
      return;
    }
    // Lab-builder errors (not found / conflict / bad plan) carry their own 4xx status.
    const st = (err as { status?: unknown })?.status;
    if (!(err instanceof PveError) && err instanceof Error && typeof st === 'number' && st >= 400 && st < 500) {
      res.status(st).json({ error: err.message, status: st });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: 'Request body is not valid JSON', status: 400 });
      return;
    }
    if (err instanceof PveError) {
      // Upstream 4xx (bad params) passes through; auth/availability problems become 502 so the
      // browser never confuses a Proxmox 401 with an app-level auth failure.
      const status = err.status === 400 || err.status === 404 ? err.status : 502;
      const message =
        err.status === 401
          ? `Proxmox rejected the credentials for this connection (${err.message})`
          : err.status === 403
            ? `Proxmox denied permission: the user or token is missing a privilege for this (${err.message})`
            : err.message;
      res.status(status).json({ error: message, status, details: err.details });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error('[server] unhandled error:', err);
    res.status(500).json({ error: message, status: 500 });
  });

  return { app, manager, store };
}

export async function startServer(o: ServerOptions): Promise<RunningServer> {
  const { app, manager } = createApp(o);
  const server: Server = createServer(app);
  const port = await new Promise<number>((res, rej) => {
    server.once('error', rej);
    server.listen(o.port, o.host, () => res((server.address() as AddressInfo).port));
  });
  return {
    port,
    dataDir: o.dataDir,
    connections: () => manager.list().map((c) => ({ name: c.name, url: c.url })),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
