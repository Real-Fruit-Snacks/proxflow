/**
 * "Test connection": one call that tells the user exactly what's wrong — or, on success,
 * what they've connected to and what the identity is allowed to do.
 */
import { isIP } from 'node:net';
import tls from 'node:tls';
import type { CertificateInfo, ConnectionInput, ProbeErrorCode, ProbeResult, TlsConfig } from '@proxflow/shared';
import { PveClient, PveError, parseHostInput } from './client.js';
import { summarizePermissions, unknownPermissions } from './permissions.js';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const portOf = (u: URL) => Number(u.port) || (u.protocol === 'https:' ? 443 : 80);

const fmtName = (n: Record<string, unknown> | undefined) =>
  n ? Object.entries(n).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('+') : String(v)}`).join(', ') : '';

/** Fetches the server certificate without verifying it (only used to *display* it for trust decisions). */
export function getCertificate(host: string, port: number, timeoutMs = 6000): Promise<CertificateInfo> {
  return new Promise((resolve, reject) => {
    const sock = tls.connect(
      { host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: timeoutMs },
      () => {
        const c = sock.getPeerCertificate();
        sock.end();
        if (!c || !c.fingerprint256) return reject(new Error('server sent no certificate'));
        const subject = fmtName(c.subject as unknown as Record<string, unknown>);
        const issuer = fmtName(c.issuer as unknown as Record<string, unknown>);
        resolve({
          fingerprint256: c.fingerprint256,
          subject,
          issuer,
          validFrom: c.valid_from,
          validTo: c.valid_to,
          altNames: c.subjectaltname,
          selfSigned: subject === issuer,
        });
      },
    );
    sock.on('error', reject);
    sock.on('timeout', () => {
      sock.destroy();
      reject(new Error('timed out fetching certificate'));
    });
  });
}

const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_SIGNATURE_FAILURE',
]);

async function classifyFailure(err: unknown, u: URL, input: ConnectionInput): Promise<ProbeResult> {
  const url = u.toString().replace(/\/+$/, '');
  const fail = (code: ProbeErrorCode, message: string, hint?: string, certificate?: CertificateInfo): ProbeResult => ({
    ok: false,
    url,
    code,
    message,
    hint,
    certificate,
  });

  if (!(err instanceof PveError)) return fail('HTTP_ERROR', msg(err));

  if (err.status === 401 || err.status === 403) {
    if (/two-factor/i.test(err.message)) return fail('AUTH_FAILED', err.message, 'Create an API token for this user (Datacenter → Permissions → API Tokens) — tokens aren\'t subject to TFA.');
    return input.auth.type === 'token'
      ? fail(
          'AUTH_FAILED',
          'Proxmox rejected the API token.',
          'Token ID must be user@realm!tokenname (e.g. root@pam!proxflow) and the secret is the UUID Proxmox showed once when the token was created. If the token has "Privilege Separation" on, it also needs its own permissions.',
        )
      : fail(
          'AUTH_FAILED',
          'Proxmox rejected the username or password.',
          'The username needs its realm, e.g. root@pam (Linux PAM) or admin@pve (Proxmox VE auth). Accounts with two-factor auth must use an API token instead.',
        );
  }

  if (!err.isNetwork) {
    return fail('HTTP_ERROR', `The server answered with HTTP ${err.status}.`, 'Make sure the URL points at the Proxmox web interface itself (not a reverse-proxy login page).');
  }

  const code = err.netCause?.code ?? '';
  const detail = err.netCause?.message ?? err.message;
  const host = u.hostname;
  const port = portOf(u);
  const certLookup = () => getCertificate(host, port).catch(() => undefined);

  if (code === 'PROXFLOW_FINGERPRINT_MISMATCH') {
    return fail(
      'TLS_FINGERPRINT_MISMATCH',
      'The server\'s certificate is different from the one you trusted.',
      'This happens after reinstalling Proxmox or renewing its certificate. Check the new fingerprint under Proxmox → node → System → Certificates, then trust it again. If you didn\'t expect a change, stop and investigate.',
      await certLookup(),
    );
  }

  if (TLS_CODES.has(code) || /certificate|self.?signed|altname/i.test(detail)) {
    const message =
      code === 'ERR_TLS_CERT_ALTNAME_INVALID'
        ? `The certificate isn't issued for "${host}" (it's probably for the node's hostname).`
        : code === 'CERT_HAS_EXPIRED'
          ? 'The server\'s certificate has expired.'
          : 'The server uses a self-signed certificate — normal for Proxmox.';
    return fail(
      'TLS_UNTRUSTED',
      message,
      'Compare the fingerprint below with Proxmox → node → System → Certificates → Fingerprint, then trust it. ProxFlow pins that exact certificate.',
      await certLookup(),
    );
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return fail('UNREACHABLE', `Couldn't resolve the host name "${host}".`, 'Check the spelling, or use the IP address instead.');
  if (code === 'ECONNREFUSED') {
    return fail(
      'UNREACHABLE',
      `Nothing is listening on ${host}:${port}.`,
      port !== 8006 ? 'Proxmox listens on port 8006 by default — try https://' + host + ':8006.' : 'Check that the host is powered on and that a firewall isn\'t blocking port 8006.',
    );
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return fail('UNREACHABLE', `No route to ${host}.`, 'Is this machine on the same network (or VPN) as the Proxmox host?');
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || /timed? ?out/i.test(detail)) {
    return fail('TIMEOUT', `${host}:${port} didn't answer in time.`, 'Usually a firewall silently dropping packets, a wrong IP, or a VPN that isn\'t connected.');
  }
  if (code === 'EPROTO' || /wrong version number|ssl3_get_record/i.test(detail)) {
    return fail('PROTOCOL', `${host}:${port} doesn't speak TLS.`, u.protocol === 'https:' ? 'If this is the ProxFlow mock or a plain-HTTP proxy, use http://. Otherwise check the port.' : undefined);
  }
  if (
    u.protocol === 'http:' &&
    (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'HPE_INVALID_CONSTANT' || /parse error|socket hang up|other side closed/i.test(detail))
  ) {
    // The connection dropped on plain HTTP. If a TLS handshake succeeds on the same port, the fix is clear.
    const cert = await certLookup();
    if (cert) return fail('PROTOCOL', 'The server expects HTTPS, not HTTP.', `Use https://${host}:${port}.`);
  }
  return fail('UNREACHABLE', `Couldn't connect to ${host}:${port}: ${detail}`, 'Check the address, port and that the host is reachable from this machine.');
}

async function probeUrl(url: string, input: ConnectionInput, tlsCfg: TlsConfig): Promise<ProbeResult> {
  const u = new URL(url);
  let client: PveClient;
  try {
    client = new PveClient({ url, auth: input.auth, tls: tlsCfg, timeoutMs: 10_000 });
  } catch (e) {
    return { ok: false, url, code: 'INVALID_URL', message: msg(e) };
  }

  let version;
  try {
    version = await client.version();
  } catch (err) {
    return classifyFailure(err, u, input);
  }
  if (!version || typeof version !== 'object' || typeof version.version !== 'string') {
    return {
      ok: false,
      url,
      code: 'NOT_PROXMOX',
      message: 'The server answered, but not like a Proxmox VE API.',
      hint: 'Check the address. If Proxmox sits behind a reverse proxy, use the proxy\'s base URL without any path.',
    };
  }

  const status = await client.clusterStatus().catch(() => []);
  const clusterEntry = status.find((s) => s.type === 'cluster');
  const nodes = status.filter((s) => s.type === 'node').map((n) => ({ name: n.name, online: n.online === 1 }));
  const permissions = await client.accessPermissions().then(summarizePermissions).catch(() => unknownPermissions());
  const certificate = u.protocol === 'https:' ? await getCertificate(u.hostname, portOf(u)).catch(() => undefined) : undefined;

  return {
    ok: true,
    url,
    version: version.version,
    release: version.release,
    mock: (version.repoid ?? '').startsWith('mock'),
    cluster: {
      name: clusterEntry?.name ?? nodes[0]?.name ?? u.hostname,
      standalone: !clusterEntry,
      quorate: clusterEntry ? clusterEntry.quorate === 1 : true,
    },
    nodes,
    permissions,
    tls: tlsCfg,
    certificate,
  };
}

export async function probeConnection(input: ConnectionInput): Promise<ProbeResult> {
  let parsed: { url: string; explicitPort: boolean };
  try {
    parsed = parseHostInput(input.url);
  } catch (e) {
    return { ok: false, url: input.url, code: 'INVALID_URL', message: msg(e) };
  }
  const tlsCfg: TlsConfig = input.tls ?? { mode: 'system' };
  const first = await probeUrl(parsed.url, input, tlsCfg);

  // "https://pve" with no port → 443 refused? Quietly try Proxmox's own port before giving up.
  if (!first.ok && !parsed.explicitPort && ['UNREACHABLE', 'TIMEOUT', 'NOT_PROXMOX', 'HTTP_ERROR', 'PROTOCOL'].includes(first.code)) {
    const u = new URL(parsed.url);
    if (u.port !== '8006') {
      u.port = '8006';
      const retry = await probeUrl(u.toString().replace(/\/+$/, ''), input, tlsCfg);
      if (retry.ok || retry.code === 'TLS_UNTRUSTED' || retry.code === 'AUTH_FAILED') return retry;
    }
  }
  return first;
}
