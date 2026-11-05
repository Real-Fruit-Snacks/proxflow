/**
 * Remembers which template a backup ("box") was restored into, per connection, so the next lab
 * clones it instead of restoring the same multi-GB backup again — the manual Proxmox flow is
 * "Restore → it appears in the sidebar as a template → Clone", and this automates the first half once.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Entry = { conn: string; volid: string; vmid: number; node: string; restoredAt: string };

export class BoxCache {
  private entries: Entry[] = [];

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { boxes?: Entry[] };
      this.entries = Array.isArray(parsed.boxes) ? parsed.boxes : [];
    } catch {
      this.entries = [];
    }
  }

  /** The template restored from this backup, if it still exists as a template in the cluster. */
  lookup(conn: string, volid: string, liveTemplates: { vmid: number; node: string }[]): { vmid: number; node: string } | undefined {
    const e = this.entries.find((x) => x.conn === conn && x.volid === volid);
    if (!e) return undefined;
    return liveTemplates.find((t) => t.vmid === e.vmid);
  }

  remember(conn: string, volid: string, vmid: number, node: string) {
    this.entries = this.entries.filter((x) => !(x.conn === conn && x.volid === volid));
    this.entries.push({ conn, volid, vmid, node, restoredAt: new Date().toISOString() });
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, boxes: this.entries }, null, 2));
    renameSync(tmp, this.file);
  }
}
