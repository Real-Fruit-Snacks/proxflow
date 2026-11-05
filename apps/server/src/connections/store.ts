/**
 * File-backed connection list. Secrets are stored as-is in this JSON file (the API
 * server is the only thing that reads it); keep the data directory out of git.
 */
import type { AuthInput, TlsConfig } from '@proxflow/shared';
import { readJsonFile, writeJsonFile } from '../json-file.js';

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
    const parsed = readJsonFile<{ connections?: StoredConnection[] }>(this.file);
    this.items = Array.isArray(parsed?.connections) ? parsed.connections : [];
  }

  /** Writes first and only then adopts the new list, so memory never disagrees with the file. */
  private save(items: StoredConnection[]) {
    writeJsonFile(this.file, { version: 1, connections: items }, 0o600);
    this.items = items;
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
    this.save(i === -1 ? [...this.items, conn] : this.items.map((c) => (c.id === conn.id ? conn : c)));
  }

  remove(id: string): boolean {
    const next = this.items.filter((c) => c.id !== id);
    if (next.length === this.items.length) return false;
    this.save(next);
    return true;
  }
}
