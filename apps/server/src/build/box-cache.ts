/**
 * Remembers which template a backup ("box") was restored into, per connection, so the next lab
 * clones it instead of restoring the same multi-GB backup again — the manual Proxmox flow is
 * "Restore → it appears in the sidebar as a template → Clone", and this automates the first half once.
 */
import { readJsonFile, writeJsonFile } from '../json-file.js';

/** `shared`: restored onto shared storage, so any node can clone it. Older entries don't say, so count as local. */
type Entry = { conn: string; volid: string; vmid: number; node: string; restoredAt: string; shared?: boolean };
type LiveTemplate = { vmid: number; node: string; box: boolean };

export class BoxCache {
  private entries: Entry[] = [];

  constructor(private readonly file: string) {
    const parsed = readJsonFile<{ boxes?: Entry[] }>(file);
    this.entries = Array.isArray(parsed?.boxes) ? parsed.boxes : [];
  }

  /**
   * The template restored from this backup that a lab on `node` can clone: it must still exist, still be a
   * ProxFlow box (VMIDs get reused), and be on that node or on shared storage.
   */
  lookup(conn: string, volid: string, node: string, liveTemplates: LiveTemplate[]): { vmid: number; node: string } | undefined {
    const candidates = this.entries
      .filter((x) => x.conn === conn && x.volid === volid)
      .sort((a, b) => Number(b.node === node) - Number(a.node === node));
    for (const e of candidates) {
      const t = liveTemplates.find((x) => x.vmid === e.vmid && x.box);
      if (t && (t.node === node || e.shared)) return { vmid: t.vmid, node: t.node };
    }
    return undefined;
  }

  remember(conn: string, volid: string, vmid: number, node: string, shared: boolean) {
    this.entries = this.entries.filter((x) => !(x.conn === conn && x.volid === volid && (x.node === node || x.vmid === vmid)));
    this.entries.push({ conn, volid, vmid, node, shared, restoredAt: new Date().toISOString() });
    try {
      writeJsonFile(this.file, { version: 1, boxes: this.entries });
    } catch (err) {
      console.error('[server] could not save the box cache:', err instanceof Error ? err.message : err);
    }
  }
}
