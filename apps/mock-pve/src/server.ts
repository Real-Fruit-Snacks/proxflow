/**
 * The mock Proxmox as a startable component: used by `pnpm dev` (src/index.ts) and by the
 * release's demo mode (apps/server/src/release.ts), which runs it in the same process.
 */
import express, { type Express } from 'express';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer, type Server } from 'node:http';
import { router } from './routes.js';
import { tick } from './state.js';

export function createMockApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => {
    if (process.env.MOCK_LOG) console.log(`[mock-pve] ${req.method} ${req.originalUrl}`);
    next();
  });
  app.use('/api2/json', router);
  app.get('/', (_req, res) =>
    res
      .type('text')
      .send(
        'ProxFlow mock Proxmox VE API.\n' +
          'Auth: Authorization: PVEAPIToken=<user@realm!name>=mock-secret  (or =readonly for an auditor-only identity)\n' +
          '      or POST /api2/json/access/ticket with username=<user@realm> password=mock\n',
      ),
  );
  return app;
}

let ticking = false;

export type MockOptions = {
  /** 0 = any free port. */
  port: number;
  host?: string;
  /** Optional self-signed HTTPS listener (exercises the "trust this certificate" flow). */
  https?: { port: number; cert: Buffer; key: Buffer };
};

export type RunningMock = { port: number; httpsPort?: number; close(): Promise<void> };

const listen = (server: Server, port: number, host?: string) =>
  new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port));
  });

export async function startMock(o: MockOptions): Promise<RunningMock> {
  if (!ticking) {
    setInterval(tick, 2000).unref();
    ticking = true;
  }
  const app = createMockApp();
  const httpServer = createHttpServer(app);
  const port = await listen(httpServer, o.port, o.host);
  let httpsServer: Server | undefined;
  let httpsPort: number | undefined;
  if (o.https) {
    httpsServer = createHttpsServer({ cert: o.https.cert, key: o.https.key }, app);
    httpsPort = await listen(httpsServer, o.https.port, o.host);
  }
  return {
    port,
    httpsPort,
    close: async () => {
      await Promise.all([httpServer, httpsServer].filter(Boolean).map((s) => new Promise<void>((r) => s!.close(() => r()))));
    },
  };
}
