/** Dev configuration (`pnpm dev`): .env files + environment variables. The release has its own CLI (release.ts). */
import { config as loadEnv } from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bool, envConnection } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));
// apps/server/.env wins over the repo-root .env; both are optional.
loadEnv({ path: [resolve(here, '../.env'), resolve(here, '../../../.env')], quiet: true });

const dataDir = process.env.PROXFLOW_DATA_DIR ?? resolve(here, '../data');

export const config = {
  port: Number(process.env.PORT ?? 3001),
  mockPort: Number(process.env.MOCK_PORT ?? 8006),
  dataDir,
  /** `pnpm dev` passes --seed-mock so the bundled fake Proxmox shows up without any setup. */
  seedMock: process.argv.includes('--seed-mock') || bool(process.env.PROXFLOW_SEED_MOCK),
  /** Topology responses are memoised this long so a busy UI doesn't hammer Proxmox. */
  topologyCacheMs: Number(process.env.TOPOLOGY_CACHE_MS ?? 2000),
  envConnection: envConnection(),
};
