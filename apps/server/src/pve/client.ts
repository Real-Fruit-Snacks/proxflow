import type { TLSSocket } from 'node:tls';
import { Agent, FormData, buildConnector, fetch, type Dispatcher } from 'undici';
import type { AuthInput, GuestAction, GuestType, TlsConfig } from '@proxflow/shared';
import type {
  RawAgentExecStatus,
  RawAgentInterfaces,
  RawClusterStatus,
  RawGuestConfig,
  RawLxcInterface,
  RawNetwork,
  RawNodeStorage,
  RawPermissions,
  RawResource,
  RawSnapshot,
  RawStorageConfig,
  RawTask,
  RawTaskLogLine,
  RawTicket,
  RawVersion,
  RawVolume,
} from './types.js';

/** Low-level reason a request never got an HTTP response (DNS, TCP, TLS, timeout). */
export type NetCause = { code?: string; message: string; name?: string };

export class PveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
    readonly netCause?: NetCause,
  ) {
    super(message);
    this.name = 'PveError';
  }
  get isNetwork() {
    return this.netCause !== undefined;
  }
}

// ───────────────────────── URL handling ─────────────────────────

/**
 * Turns whatever a user types into a canonical base URL.
 *   "192.168.1.10"            → https://192.168.1.10:8006   (bare host: assume Proxmox defaults)
 *   "pve.lan:8006"            → https://pve.lan:8006
 *   "https://pve.example.com" → https://pve.example.com     (explicit scheme, no port: respect it — reverse proxies)
 *   "https://pve:8006/api2/json/" → https://pve:8006
 */
export function parseHostInput(input: string): { url: string; explicitPort: boolean } {
  const raw = input.trim();
  if (!raw) throw new Error('Enter the Proxmox host — e.g. 192.168.1.10 or https://pve.lan:8006');
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let u: URL;
  try {
    u = new URL(hadScheme ? raw : `https://${raw}`);
  } catch {
    throw new Error(`"${raw}" isn't a valid host name or URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('The URL must start with https:// (or http:// for the mock server)');
  if (!u.hostname) throw new Error('The URL has no host name');
  const explicitPort = u.port !== '';
  if (!hadScheme && !explicitPort) u.port = '8006';
  u.pathname = u.pathname.replace(/\/api2\/(json|extjs)(\/.*)?$/i, '/').replace(/\/+$/, '');
  u.search = '';
  u.hash = '';
  u.username = '';
  u.password = '';
  return { url: u.toString().replace(/\/+$/, ''), explicitPort };
}

export const normalizePveUrl = (input: string) => parseHostInput(input).url;

// ───────────────────────── TLS ─────────────────────────

export const normalizeFingerprint = (fp: string) => fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
export const formatFingerprint = (fp: string) => normalizeFingerprint(fp).match(/.{1,2}/g)?.join(':') ?? fp;

/**
 * Trust-on-first-use: accept any chain, but only if the leaf certificate's SHA-256
 * fingerprint matches the pinned one. (Node only runs `checkServerIdentity` after the
 * chain verifies, so a custom connector is the reliable place to pin self-signed certs.)
 */
function pinnedConnector(fingerprint: string): buildConnector.connector {
  // Session caching must be off: a resumed TLS 1.3 session doesn't resend the server
  // certificate, so getPeerCertificate() would come back empty and the pin check would fail.
  const inner = buildConnector({ rejectUnauthorized: false, maxCachedSessions: 0 });
  const want = normalizeFingerprint(fingerprint);
  return (opts, cb) => {
    inner(opts, (err, socket) => {
      if (err) return cb(err, null);
      if (!socket) return cb(new Error('connector returned no socket'), null);
      if (opts.protocol === 'https:') {
        const got = normalizeFingerprint((socket as TLSSocket).getPeerCertificate()?.fingerprint256 ?? '');
        if (got !== want) {
          socket.destroy();
          const e = Object.assign(
            new Error(
              got
                ? `certificate fingerprint ${formatFingerprint(got)} doesn't match the trusted ${formatFingerprint(want)}`
                : 'the server presented no certificate to check against the trusted fingerprint',
            ),
            { code: 'PROXFLOW_FINGERPRINT_MISMATCH' },
          );
          return cb(e, null);
        }
      }
      cb(null, socket);
    });
  };
}

export function createDispatcher(tls?: TlsConfig): Dispatcher | undefined {
  switch (tls?.mode) {
    case 'insecure':
      return new Agent({ connect: { rejectUnauthorized: false } });
    case 'pinned':
      if (!tls.fingerprint) throw new Error('Pinned TLS mode needs a certificate fingerprint');
      return new Agent({ connect: pinnedConnector(tls.fingerprint) });
    default:
      return undefined; // system trust store
  }
}

// ───────────────────────── client ─────────────────────────

export interface PveClientOptions {
  url: string;
  auth: AuthInput;
  tls?: TlsConfig;
  timeoutMs?: number;
}

/** Arrays are sent as repeated keys (Proxmox "array" parameters, e.g. agent exec's command). */
export type Params = Record<string, string | number | boolean | string[] | undefined>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const TICKET_TTL_MS = 90 * 60 * 1000; // Proxmox tickets live 2h; renew comfortably before that.

/**
 * Typed wrapper over the Proxmox REST API. Supports API tokens (stateless) and
 * username/password (ticket + CSRF token, renewed automatically). Works identically
 * against a real host and apps/mock-pve.
 */
export class PveClient {
  private readonly dispatcher?: Dispatcher;
  private ticket?: { ticket: string; csrf: string; at: number };
  private loginInflight?: Promise<void>;

  constructor(private readonly opts: PveClientOptions) {
    this.dispatcher = createDispatcher(opts.tls);
  }

  get baseUrl() {
    return this.opts.url;
  }

  private async send(
    method: Method,
    path: string,
    { query, body, form, authenticated = true }: { query?: Params; body?: Params; form?: FormData; authenticated?: boolean },
  ) {
    const url = new URL(`${this.opts.url}/api2/json${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (authenticated) {
      const a = this.opts.auth;
      if (a.type === 'token') {
        headers.Authorization = `PVEAPIToken=${a.tokenId}=${a.secret}`;
      } else {
        await this.ensureTicket();
        headers.Cookie = `PVEAuthCookie=${this.ticket!.ticket}`;
        if (method !== 'GET') headers.CSRFPreventionToken = this.ticket!.csrf;
      }
    }

    let payload: string | FormData | undefined;
    if (form) {
      payload = form; // undici sets the multipart boundary header itself
    } else if (body) {
      const encoded = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) for (const item of v) encoded.append(k, item);
        else encoded.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
      }
      payload = encoded.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: payload,
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      throw this.networkError(err);
    }

    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      throw this.networkError(err);
    }
    let json: { data?: unknown; message?: string; errors?: unknown } | null = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, ok: res.ok, statusText: res.statusText, json, text };
  }

  private networkError(err: unknown): PveError {
    const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string; name?: string } };
    const timeout = e.name === 'TimeoutError' || e.name === 'AbortError';
    const code = e.cause?.code ?? (timeout ? 'ETIMEDOUT' : undefined);
    const message = timeout ? 'timed out waiting for a response' : (e.cause?.message ?? e.message ?? String(err));
    return new PveError(`Could not reach Proxmox at ${this.opts.url}: ${message}`, 502, undefined, {
      code,
      message,
      name: e.cause?.name ?? e.name,
    });
  }

  private async login(): Promise<void> {
    const a = this.opts.auth;
    if (a.type !== 'password') return;
    const username = a.username.includes('@') ? a.username : `${a.username}@pam`;
    const r = await this.send('POST', '/access/ticket', { body: { username, password: a.password }, authenticated: false });
    if (r.status === 401) throw new PveError('Login rejected: wrong username, realm or password', 401, r.json?.errors);
    if (!r.ok) throw new PveError(`Login failed: ${r.status} ${r.json?.message ?? r.statusText}`, r.status, r.json?.errors ?? r.text);
    const d = r.json?.data as RawTicket | undefined;
    if (d?.NeedTFA) {
      throw new PveError('This account requires two-factor authentication, which API logins can\'t complete — use an API token instead', 401);
    }
    if (!d?.ticket || !d.CSRFPreventionToken) throw new PveError('Proxmox login returned no ticket', 502);
    this.ticket = { ticket: d.ticket, csrf: d.CSRFPreventionToken, at: Date.now() };
  }

  private async ensureTicket(): Promise<void> {
    if (this.opts.auth.type !== 'password') return;
    if (this.ticket && Date.now() - this.ticket.at < TICKET_TTL_MS) return;
    if (!this.loginInflight) {
      this.loginInflight = this.login().finally(() => {
        this.loginInflight = undefined;
      });
    }
    await this.loginInflight;
  }

  private async request<T>(
    method: Method,
    path: string,
    opts: { query?: Params; body?: Params; form?: () => FormData } = {},
    retryAuth = true,
  ): Promise<T> {
    // `form` is a factory: a FormData body can't be re-sent after a ticket refresh.
    const r = await this.send(method, path, { query: opts.query, body: opts.body, form: opts.form?.() });
    if (r.status === 401 && this.opts.auth.type === 'password' && retryAuth) {
      this.ticket = undefined; // expired or revoked — log in again once
      return this.request<T>(method, path, opts, false);
    }
    if (!r.ok) {
      const errors = r.json?.errors;
      const detail =
        r.json?.message ??
        (errors && typeof errors === 'object' ? Object.values(errors as Record<string, unknown>).join('; ') : undefined) ??
        r.statusText;
      throw new PveError(`Proxmox ${method} ${path} failed: ${r.status} ${detail}`, r.status, errors ?? r.text);
    }
    return (r.json?.data ?? null) as T;
  }

  get<T>(path: string, query?: Params) {
    return this.request<T>('GET', path, { query });
  }
  post<T>(path: string, body?: Params) {
    return this.request<T>('POST', path, { body });
  }
  put<T>(path: string, body?: Params) {
    return this.request<T>('PUT', path, { body });
  }
  delete<T>(path: string, query?: Params) {
    return this.request<T>('DELETE', path, { query });
  }
  postForm<T>(path: string, form: () => FormData) {
    return this.request<T>('POST', path, { form });
  }

  // ───── typed helpers ─────

  version() {
    return this.get<RawVersion>('/version');
  }
  clusterStatus() {
    return this.get<RawClusterStatus[]>('/cluster/status');
  }
  clusterResources(type?: 'node' | 'vm' | 'storage' | 'sdn') {
    return this.get<RawResource[]>('/cluster/resources', { type });
  }
  /** Effective privileges of the current user/token, keyed by ACL path. */
  accessPermissions() {
    return this.get<RawPermissions>('/access/permissions');
  }
  nodeNetwork(node: string) {
    return this.get<RawNetwork[]>(`/nodes/${enc(node)}/network`);
  }
  guestConfig(node: string, type: GuestType, vmid: number): Promise<RawGuestConfig> {
    return this.get<RawGuestConfig>(`/nodes/${enc(node)}/${type}/${vmid}/config`);
  }
  guestStatusAction(node: string, type: GuestType, vmid: number, action: GuestAction) {
    return this.post<string>(`/nodes/${enc(node)}/${type}/${vmid}/status/${action}`);
  }
  taskStatus(node: string, upid: string) {
    return this.get<RawTask>(`/nodes/${enc(node)}/tasks/${enc(upid)}/status`);
  }
  snapshots(node: string, type: GuestType, vmid: number) {
    return this.get<RawSnapshot[]>(`/nodes/${enc(node)}/${type}/${vmid}/snapshot`);
  }
  createSnapshot(node: string, type: GuestType, vmid: number, snapname: string, description?: string, vmstate?: boolean) {
    return this.post<string>(`/nodes/${enc(node)}/${type}/${vmid}/snapshot`, {
      snapname,
      description,
      ...(type === 'qemu' ? { vmstate } : {}),
    });
  }
  deleteSnapshot(node: string, type: GuestType, vmid: number, snapname: string) {
    return this.delete<string>(`/nodes/${enc(node)}/${type}/${vmid}/snapshot/${enc(snapname)}`);
  }
  clone(
    node: string,
    type: GuestType,
    vmid: number,
    opts: { newid: number; name?: string; hostname?: string; full?: boolean; target?: string; storage?: string; description?: string },
  ) {
    return this.post<string>(`/nodes/${enc(node)}/${type}/${vmid}/clone`, opts);
  }

  // ───── lab builder ─────

  nextId() {
    return this.get<string | number>('/cluster/nextid').then(Number);
  }
  nodeStorages(node: string) {
    return this.get<RawNodeStorage[]>(`/nodes/${enc(node)}/storage`);
  }
  storageConfig(storage: string) {
    return this.get<RawStorageConfig>(`/storage/${enc(storage)}`);
  }
  updateStorage(storage: string, params: Params) {
    return this.put<null>(`/storage/${enc(storage)}`, params);
  }
  storageContent(node: string, storage: string, content?: string) {
    return this.get<RawVolume[]>(`/nodes/${enc(node)}/storage/${enc(storage)}/content`, { content });
  }
  /** Full text of the guest config embedded in a vzdump backup. */
  backupConfig(node: string, volume: string) {
    return this.get<string>(`/nodes/${enc(node)}/vzdump/extractconfig`, { volume });
  }
  downloadUrl(node: string, storage: string, params: { url: string; content: string; filename: string }) {
    return this.post<string>(`/nodes/${enc(node)}/storage/${enc(storage)}/download-url`, params);
  }
  /** Multipart upload; Proxmox requires `content` before the file part. */
  uploadFile(node: string, storage: string, content: 'iso' | 'vztmpl' | 'import', filename: string, data: Uint8Array) {
    return this.postForm<string>(`/nodes/${enc(node)}/storage/${enc(storage)}/upload`, () => {
      const f = new FormData();
      f.append('content', content);
      f.append('filename', new Blob([data], { type: 'application/octet-stream' }), filename);
      return f;
    });
  }
  deleteVolume(node: string, storage: string, volid: string) {
    return this.delete<string | null>(`/nodes/${enc(node)}/storage/${enc(storage)}/content/${enc(volid)}`);
  }
  /** Create a VM/CT. With `archive` (qemu) or `ostemplate` + `restore=1` (lxc) this restores a backup. */
  createGuest(node: string, type: GuestType, params: Params) {
    return this.post<string>(`/nodes/${enc(node)}/${type}`, params);
  }
  convertToTemplate(node: string, type: GuestType, vmid: number) {
    return this.post<string | null>(`/nodes/${enc(node)}/${type}/${vmid}/template`);
  }
  updateConfig(node: string, type: GuestType, vmid: number, params: Params) {
    return this.put<null>(`/nodes/${enc(node)}/${type}/${vmid}/config`, params);
  }
  resize(node: string, type: GuestType, vmid: number, disk: string, size: string) {
    return this.put<string | null>(`/nodes/${enc(node)}/${type}/${vmid}/resize`, { disk, size });
  }
  guestStatus(node: string, type: GuestType, vmid: number) {
    return this.get<Record<string, unknown> & { status: string }>(`/nodes/${enc(node)}/${type}/${vmid}/status/current`);
  }
  destroyGuest(node: string, type: GuestType, vmid: number) {
    return this.delete<string>(`/nodes/${enc(node)}/${type}/${vmid}`, { purge: 1, 'destroy-unreferenced-disks': 1 });
  }
  taskLog(node: string, upid: string, limit = 5000) {
    return this.get<RawTaskLogLine[]>(`/nodes/${enc(node)}/tasks/${enc(upid)}/log`, { start: 0, limit });
  }
  sendKey(node: string, vmid: number, key: string) {
    return this.put<null>(`/nodes/${enc(node)}/qemu/${vmid}/sendkey`, { key });
  }
  lxcInterfaces(node: string, vmid: number) {
    return this.get<RawLxcInterface[]>(`/nodes/${enc(node)}/lxc/${vmid}/interfaces`);
  }

  // ───── QEMU guest agent ─────

  agentPing(node: string, vmid: number) {
    return this.post<unknown>(`/nodes/${enc(node)}/qemu/${vmid}/agent/ping`);
  }
  agentInterfaces(node: string, vmid: number) {
    return this.get<RawAgentInterfaces>(`/nodes/${enc(node)}/qemu/${vmid}/agent/network-get-interfaces`);
  }
  agentFileRead(node: string, vmid: number, file: string) {
    return this.get<{ content: string; truncated?: boolean }>(`/nodes/${enc(node)}/qemu/${vmid}/agent/file-read`, { file });
  }
  /** Proxmox base64-encodes `content` for the agent itself (encode defaults to 1). */
  agentFileWrite(node: string, vmid: number, file: string, content: string) {
    return this.post<null>(`/nodes/${enc(node)}/qemu/${vmid}/agent/file-write`, { file, content });
  }
  agentExec(node: string, vmid: number, command: string[]) {
    return this.post<{ pid: number }>(`/nodes/${enc(node)}/qemu/${vmid}/agent/exec`, { command });
  }
  agentExecStatus(node: string, vmid: number, pid: number) {
    return this.get<RawAgentExecStatus>(`/nodes/${enc(node)}/qemu/${vmid}/agent/exec-status`, { pid });
  }
}

/** Encodes one path segment. "." and ".." would be folded away by URL parsing and retarget the request. */
const enc = (segment: string) => {
  if (segment === '' || segment === '.' || segment === '..') throw new PveError(`invalid path segment '${segment}'`, 400);
  return encodeURIComponent(segment);
};
