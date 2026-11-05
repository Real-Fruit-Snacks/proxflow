import { randomUUID } from 'node:crypto';
import type {
  AuthInput,
  AuthPublic,
  ClusterInfo,
  Connection,
  ConnectionInput,
  ConnectionStatus,
  ProbeResult,
  TlsConfig,
  TopoEdge,
  TopoNode,
  Topology,
} from '@proxflow/shared';
import { PveClient, PveError, normalizePveUrl } from '../pve/client.js';
import { probeConnection } from '../pve/probe.js';
import { createTopologyService, type TopologyService } from '../pve/topology.js';
import { ConnectionStore, type StoredConnection } from './store.js';

export class NotFoundError extends Error {
  readonly status = 404;
}

interface Entry {
  conn: StoredConnection;
  client: PveClient;
  topology: TopologyService;
  status?: ConnectionStatus;
}

const redact = (auth: AuthInput): AuthPublic =>
  auth.type === 'token' ? { type: 'token', tokenId: auth.tokenId } : { type: 'password', username: auth.username };

/** Short, user-facing reason a connection is failing on the map. */
export function friendlyError(err: unknown): string {
  if (err instanceof PveError) {
    if (err.status === 401 || err.status === 403) return 'Proxmox rejected the credentials — open Connections to fix them.';
    if (err.isNetwork) {
      const code = err.netCause?.code ?? '';
      const detail = err.netCause?.message ?? err.message;
      if (code === 'PROXFLOW_FINGERPRINT_MISMATCH') return 'The host\'s certificate changed since you trusted it — open Connections to review and re-trust it.';
      if (/certificate|self.?signed|altname/i.test(detail)) return 'The host\'s certificate isn\'t trusted — open Connections and trust it.';
      if (code === 'ECONNREFUSED') return 'Connection refused — is Proxmox running and is the port right?';
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Host name not found.';
      if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'Timed out — the host is down or a firewall is in the way.';
      return `Unreachable: ${detail}`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Owns one PveClient + topology cache per saved connection. */
export class ConnectionManager {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly store: ConnectionStore,
    private readonly cacheMs: number,
  ) {
    for (const c of store.list()) {
      try {
        this.entries.set(c.id, this.build(c));
      } catch (err) {
        console.error(`[server] skipping connection "${c.name}":`, err instanceof Error ? err.message : err);
      }
    }
  }

  private build(conn: StoredConnection): Entry {
    const client = new PveClient({ url: conn.url, auth: conn.auth, tls: conn.tls });
    return { conn, client, topology: createTopologyService(client, { id: conn.id, name: conn.name }, this.cacheMs) };
  }

  private toPublic(e: Entry): Connection {
    const { id, name, url, auth, tls, enabled, createdAt } = e.conn;
    return { id, name, url, auth: redact(auth), tls, enabled, createdAt, status: e.status };
  }

  private entry(id: string): Entry {
    const e = this.entries.get(id);
    if (!e) throw new NotFoundError(`No connection with id "${id}"`);
    return e;
  }

  list(): Connection[] {
    return [...this.entries.values()].map((e) => this.toPublic(e));
  }

  client(id: string): PveClient {
    return this.entry(id).client;
  }

  info(id: string): { id: string; name: string } {
    const { conn } = this.entry(id);
    return { id: conn.id, name: conn.name };
  }

  /** Cached topology of one connection (used by the lab builder to spot IPs already in use). */
  clusterTopology(id: string) {
    return this.entry(id).topology.get();
  }

  add(input: ConnectionInput, fixedId?: string, persist = true): Connection {
    const url = normalizePveUrl(input.url);
    const id = fixedId ?? randomUUID().slice(0, 8);
    const conn: StoredConnection = {
      id,
      name: input.name?.trim() || new URL(url).hostname,
      url,
      auth: input.auth,
      tls: input.tls ?? { mode: 'system' },
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString(),
    };
    const entry = this.build(conn); // validates TLS config before persisting
    if (persist) this.store.upsert(conn);
    this.entries.set(id, entry);
    return this.toPublic(entry);
  }

  /** Blank secrets in `input` keep the stored ones, so the UI never has to echo them back. */
  merge(existing: StoredConnection, input: Partial<ConnectionInput>): StoredConnection {
    let auth: AuthInput = existing.auth;
    if (input.auth) {
      if (input.auth.type === 'token') {
        const keep = existing.auth.type === 'token' && existing.auth.tokenId === input.auth.tokenId ? existing.auth.secret : '';
        auth = { type: 'token', tokenId: input.auth.tokenId, secret: input.auth.secret || keep };
      } else {
        const keep = existing.auth.type === 'password' && existing.auth.username === input.auth.username ? existing.auth.password : '';
        auth = { type: 'password', username: input.auth.username, password: input.auth.password || keep };
      }
    }
    return {
      ...existing,
      name: input.name?.trim() || existing.name,
      url: input.url ? normalizePveUrl(input.url) : existing.url,
      auth,
      tls: input.tls ?? existing.tls,
      enabled: input.enabled ?? existing.enabled,
    };
  }

  update(id: string, input: Partial<ConnectionInput>): Connection {
    const e = this.entry(id);
    const conn = this.merge(e.conn, input);
    const entry = this.build(conn);
    this.store.upsert(conn);
    this.entries.set(id, entry);
    return this.toPublic(entry);
  }

  remove(id: string) {
    this.entry(id);
    this.entries.delete(id);
    this.store.remove(id);
  }

  /** Probe a saved connection, optionally with unsaved edits from the form (blank secrets = stored ones). */
  probe(id: string, overrides?: Partial<ConnectionInput>): Promise<ProbeResult> {
    const e = this.entry(id);
    const conn = overrides ? this.merge(e.conn, overrides) : e.conn;
    return probeConnection({ name: conn.name, url: conn.url, auth: conn.auth, tls: conn.tls });
  }

  /**
   * Adds an in-memory connection for this run only (mock / PVE_URL env). Not written to
   * connections.json, so `pnpm dev:real` never shows a stale mock and env stays the source of truth.
   * Skipped if a saved connection already points at the same URL.
   */
  seed(seed: { id: string; name: string; url: string; auth: AuthInput; tls: TlsConfig }) {
    const url = normalizePveUrl(seed.url);
    if (this.entries.has(seed.id) || [...this.entries.values()].some((e) => e.conn.url === url)) return;
    this.add({ name: seed.name, url, auth: seed.auth, tls: seed.tls }, seed.id, false);
    console.log(`[server] using connection "${seed.name}" → ${url} (from ${seed.id === 'mock' ? '--seed-mock' : 'environment'}, not saved)`);
  }

  invalidate(id?: string) {
    if (id) this.entries.get(id)?.topology.invalidate();
    else for (const e of this.entries.values()) e.topology.invalidate();
  }

  /** Merges every enabled connection into one graph; a failing host becomes an error cluster, not a failed request. */
  async topology(): Promise<Topology> {
    const entries = [...this.entries.values()].filter((e) => e.conn.enabled);
    const results = await Promise.allSettled(entries.map((e) => e.topology.get()));
    const now = new Date().toISOString();
    const clusters: ClusterInfo[] = [];
    const nodes: TopoNode[] = [];
    const edges: TopoEdge[] = [];

    results.forEach((r, i) => {
      const e = entries[i]!;
      if (r.status === 'fulfilled') {
        clusters.push(r.value.cluster);
        nodes.push(...r.value.nodes);
        edges.push(...r.value.edges);
        e.status = { ok: true, checkedAt: now, version: r.value.cluster.version, clusterName: r.value.cluster.name, mock: r.value.cluster.mock };
      } else {
        const error = friendlyError(r.reason);
        clusters.push({ conn: e.conn.id, connName: e.conn.name, name: e.conn.name, quorate: false, nodeCount: 0, ok: false, error });
        e.status = { ok: false, checkedAt: now, error };
      }
    });

    return { clusters, nodes, edges, fetchedAt: now };
  }
}
