import type { AuthInput, TlsConfig } from '@proxflow/shared';

export const bool = (v: string | undefined) => /^(1|true|yes|on)$/i.test(v ?? '');

export type SeedConnection = { name: string; url: string; auth: AuthInput; tls: TlsConfig };

/** Optional headless setup: a connection defined purely through environment variables (Docker, CI, services). */
export function envConnection(env: NodeJS.ProcessEnv = process.env): SeedConnection | undefined {
  const url = env.PVE_URL;
  if (!url) return undefined;
  const { PVE_TOKEN_ID, PVE_TOKEN_SECRET, PVE_USERNAME, PVE_PASSWORD, PVE_FINGERPRINT, PVE_INSECURE_TLS, PVE_NAME } = env;
  const auth: AuthInput | undefined =
    PVE_TOKEN_ID && PVE_TOKEN_SECRET
      ? { type: 'token', tokenId: PVE_TOKEN_ID, secret: PVE_TOKEN_SECRET }
      : PVE_USERNAME && PVE_PASSWORD
        ? { type: 'password', username: PVE_USERNAME, password: PVE_PASSWORD }
        : undefined;
  if (!auth) {
    console.warn('[server] PVE_URL is set but no credentials were given (PVE_TOKEN_ID + PVE_TOKEN_SECRET, or PVE_USERNAME + PVE_PASSWORD) — ignoring');
    return undefined;
  }
  const tls: TlsConfig = PVE_FINGERPRINT ? { mode: 'pinned', fingerprint: PVE_FINGERPRINT } : bool(PVE_INSECURE_TLS) ? { mode: 'insecure' } : { mode: 'system' };
  let name = PVE_NAME;
  if (!name) {
    try {
      name = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname;
    } catch {
      name = 'Proxmox';
    }
  }
  return { name, url, auth, tls };
}
