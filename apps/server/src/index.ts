/** Dev entry (`pnpm dev` / `pnpm dev:real`): API only — Vite serves the UI and proxies /api here. */
import { startServer } from './app.js';
import { config } from './config.js';

const seeds = [];
if (config.seedMock) {
  seeds.push({
    id: 'mock',
    name: 'Mock homelab',
    url: `http://localhost:${config.mockPort}`,
    auth: { type: 'token' as const, tokenId: 'root@pam!proxflow', secret: 'mock-secret' },
    tls: { mode: 'system' as const },
  });
}
if (config.envConnection) seeds.push({ id: 'env', ...config.envConnection });

const server = await startServer({ port: config.port, dataDir: config.dataDir, topologyCacheMs: config.topologyCacheMs, seeds });
const list = server.connections();
console.log(`[server] ProxFlow API on http://localhost:${server.port}/api`);
console.log(`[server] ${list.length} connection(s), data in ${server.dataDir}${list.length ? ': ' + list.map((c) => `${c.name} → ${c.url}`).join(', ') : ' — add one in the UI'}`);
