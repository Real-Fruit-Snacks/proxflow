/**
 * Discrete, composable operations against Proxmox.
 *
 * The map UI calls these one at a time; the planned workflow mode will chain
 * them (clone → configure → start → snapshot …), so keep each one self-contained
 * and returning a UPID or a resolved task.
 */
import type { GuestAction, GuestType, Snapshot, TaskStatus } from '@proxflow/shared';
import type { PveClient } from './client.js';
import type { RawTask } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const toTaskStatus = (t: RawTask): TaskStatus => ({
  upid: t.upid,
  node: t.node,
  type: t.type,
  id: t.id,
  user: t.user,
  status: t.status,
  exitstatus: t.exitstatus,
  starttime: t.starttime,
});

export const operations = {
  guestAction(client: PveClient, node: string, type: GuestType, vmid: number, action: GuestAction) {
    return client.guestStatusAction(node, type, vmid, action);
  },

  /** Polls a task until it stops or `timeoutMs` elapses; returns the last observed status either way. */
  async waitForTask(
    client: PveClient,
    node: string,
    upid: string,
    { timeoutMs = 25_000, intervalMs = 600 }: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<TaskStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = await client.taskStatus(node, upid);
      if (t.status === 'stopped' || Date.now() >= deadline) return toTaskStatus(t);
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
    }
  },

  async listSnapshots(client: PveClient, node: string, type: GuestType, vmid: number): Promise<Snapshot[]> {
    const raw = await client.snapshots(node, type, vmid);
    return raw.map((s) => ({
      name: s.name,
      description: s.description,
      snaptime: s.snaptime,
      parent: s.parent,
      vmstate: s.vmstate === 1,
      current: s.name === 'current',
    }));
  },

  createSnapshot(client: PveClient, node: string, type: GuestType, vmid: number, name: string, description?: string, vmstate?: boolean) {
    return client.createSnapshot(node, type, vmid, name, description, vmstate);
  },

  deleteSnapshot(client: PveClient, node: string, type: GuestType, vmid: number, name: string) {
    return client.deleteSnapshot(node, type, vmid, name);
  },

  clone(client: PveClient, node: string, type: GuestType, vmid: number, opts: { newid: number; name?: string; full?: boolean; target?: string }) {
    return client.clone(node, type, vmid, opts);
  },
};
