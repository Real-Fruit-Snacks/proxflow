/** Dev entry: `pnpm --filter @proxflow/mock-pve dev`. */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.MOCK_PORT ?? 8006);
const httpsPort = Number(process.env.MOCK_HTTPS_PORT ?? 8007);
// Optional HTTPS listener with a self-signed cert: `pnpm --filter @proxflow/mock-pve gen-cert`
const certFile = resolve(here, '../certs/cert.pem');
const keyFile = resolve(here, '../certs/key.pem');
const certs = existsSync(certFile) && existsSync(keyFile) ? { cert: readFileSync(certFile), key: readFileSync(keyFile) } : undefined;

const mock = await startMock({ port, https: certs ? { port: httpsPort, ...certs } : undefined });
console.log(`[mock-pve] fake Proxmox listening on http://localhost:${mock.port}/api2/json`);
if (mock.httpsPort) console.log(`[mock-pve] … and on https://localhost:${mock.httpsPort}/api2/json (self-signed, like a real Proxmox)`);
else console.log(`[mock-pve] (no certs/cert.pem — run "pnpm --filter @proxflow/mock-pve gen-cert" to also serve self-signed HTTPS on :${httpsPort})`);
