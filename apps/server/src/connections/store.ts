/**
 * File-backed connection list. Secrets are stored as-is in this JSON file (the API
 * server is the only thing that reads it); keep the data directory out of git.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuthInput, TlsConfig } from '@proxflow/shared';

export interface StoredConnection {
  id: string;
  name: string;
  url: string;
  auth: AuthInput;
  tls: TlsConfig;
  enabled: boolean;
  createdAt: string;
}

export class ConnectionStore {
  private items: StoredConnection[] = [];

  constructor(private readonly file: string) {
    this.load();
  }

  private load() {
    if (!existsSync(this.file)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { connections?: StoredConnection[] };
      this.items = Array.isArray(parsed.connections) ? parsed.connections : [];
    } catch (err) {
      console.error(`[server] could not read ${this.file}:`, err instanceof Error ? err.message : err);
    }
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, connections: this.items }, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  get path() {
    return this.file;
  }

  list(): StoredConnection[] {
    return [...this.items];
  }

  get(id: string): StoredConnection | undefined {
    return this.items.find((c) => c.id === id);
  }

  upsert(conn: StoredConnection) {
    const i = this.items.findIndex((c) => c.id === conn.id);
    if (i === -1) this.items.push(conn);
    else this.items[i] = conn;
    this.save();
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((c) => c.id !== id);
    if (this.items.length !== before) this.save();
    return this.items.length !== before;
  }
}
