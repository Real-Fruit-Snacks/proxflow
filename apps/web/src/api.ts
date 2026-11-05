import {
  keepPreviousData,
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useMemo } from 'react';
import { toast } from 'sonner';
import type {
  Connection,
  ConnectionInput,
  GuestAction,
  GuestData,
  HealthInfo,
  ProbeResult,
  Snapshot,
  TaskStatus,
  Topology,
} from '@proxflow/shared';

async function http<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return body as T;
}

const enc = encodeURIComponent;
type GuestRef = Pick<GuestData, 'conn' | 'node' | 'type' | 'vmid'>;
const guestPath = (g: GuestRef) => `/api/guests/${enc(g.conn)}/${enc(g.node)}/${g.type}/${g.vmid}`;

export const api = {
  health: () => http<HealthInfo>('/api/health'),
  topology: () => http<Topology>('/api/topology'),

  connections: () => http<Connection[]>('/api/connections'),
  testConnection: (input: ConnectionInput) => http<ProbeResult>('/api/connections/test', { method: 'POST', body: JSON.stringify(input) }),
  testSavedConnection: (id: string, overrides?: ConnectionInput) =>
    http<ProbeResult>(`/api/connections/${enc(id)}/test`, { method: 'POST', body: JSON.stringify(overrides ?? {}) }),
  createConnection: (input: ConnectionInput) => http<Connection>('/api/connections', { method: 'POST', body: JSON.stringify(input) }),
  updateConnection: (id: string, input: ConnectionInput) => http<Connection>(`/api/connections/${enc(id)}`, { method: 'PUT', body: JSON.stringify(input) }),
  deleteConnection: (id: string) => http<{ ok: true }>(`/api/connections/${enc(id)}`, { method: 'DELETE' }),

  guestAction: (g: GuestRef, action: GuestAction) => http<{ upid: string }>(`${guestPath(g)}/${action}`, { method: 'POST' }),
  task: (conn: string, node: string, upid: string, waitMs = 25_000) =>
    http<TaskStatus>(`/api/tasks/${enc(conn)}/${enc(node)}/${enc(upid)}?wait=${waitMs}`),
  /** Long-polls the server until the Proxmox task finishes. */
  async waitForTask(conn: string, node: string, upid: string): Promise<TaskStatus> {
    for (let i = 0; i < 40; i++) {
      const t = await api.task(conn, node, upid);
      if (t.status === 'stopped') return t;
    }
    throw new Error('Timed out waiting for Proxmox task');
  },
  snapshots: (g: GuestRef) => http<Snapshot[]>(`${guestPath(g)}/snapshots`),
  createSnapshot: (g: GuestRef, name: string, description?: string) =>
    http<{ upid: string }>(`${guestPath(g)}/snapshots`, { method: 'POST', body: JSON.stringify({ name, description }) }),
  deleteSnapshot: (g: GuestRef, name: string) =>
    http<{ upid: string }>(`${guestPath(g)}/snapshots/${enc(name)}`, { method: 'DELETE' }),
};

const assertOk = (t: TaskStatus) => {
  if (t.exitstatus && t.exitstatus !== 'OK') throw new Error(t.exitstatus);
  return t;
};

export const topologyKey = ['topology'] as const;
export const connectionsKey = ['connections'] as const;

export function useTopology(live: boolean) {
  return useQuery({
    queryKey: topologyKey,
    queryFn: api.topology,
    refetchInterval: live ? 4000 : false,
    placeholderData: keepPreviousData,
  });
}

export function useConnections() {
  return useQuery({ queryKey: connectionsKey, queryFn: api.connections, refetchInterval: 10_000 });
}

export type TestVars = { id?: string; input: ConnectionInput };

export function useTestConnection() {
  return useMutation({
    mutationFn: ({ id, input }: TestVars) => (id ? api.testSavedConnection(id, input) : api.testConnection(input)),
  });
}

export function useSaveConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: TestVars) => (id ? api.updateConnection(id, input) : api.createConnection(input)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectionsKey });
      qc.invalidateQueries({ queryKey: topologyKey });
    },
  });
}

export function useDeleteConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteConnection(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: connectionsKey });
      qc.invalidateQueries({ queryKey: topologyKey });
    },
  });
}

const VERB: Record<GuestAction, string> = {
  start: 'Starting',
  stop: 'Stopping',
  shutdown: 'Shutting down',
  reboot: 'Rebooting',
  suspend: 'Suspending',
  resume: 'Resuming',
};

export type GuestActionVars = { guest: GuestData; action: GuestAction; vmid: number };
const GUEST_ACTION_KEY = ['guest-action'] as const;

export function useGuestAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: GUEST_ACTION_KEY,
    mutationFn: async ({ guest, action }: GuestActionVars) => {
      const { upid } = await api.guestAction(guest, action);
      return assertOk(await api.waitForTask(guest.conn, guest.node, upid));
    },
    onMutate: ({ guest, action }) => {
      toast.loading(`${VERB[action]} ${guest.name}…`, { id: `guest-${guest.conn}-${guest.vmid}` });
    },
    onSuccess: (_task, { guest, action }) => {
      toast.success(`${guest.name}: ${action} complete`, { id: `guest-${guest.conn}-${guest.vmid}` });
    },
    onError: (err, { guest, action }) => {
      toast.error(`${guest.name}: ${action} failed — ${err.message}`, { id: `guest-${guest.conn}-${guest.vmid}` });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: topologyKey }),
  });
}

/** Guests ("conn/vmid") with an in-flight power action, so cards can show a spinner. VMIDs repeat across clusters. */
export function usePendingGuests(): Set<string> {
  const keys = useMutationState({
    filters: { mutationKey: GUEST_ACTION_KEY, status: 'pending' },
    select: (m) => {
      const v = m.state.variables as GuestActionVars | undefined;
      return v ? `${v.guest.conn}/${v.vmid}` : undefined;
    },
  });
  const key = keys.filter((k): k is string => typeof k === 'string').sort().join(',');
  return useMemo(() => new Set(key ? key.split(',') : []), [key]);
}

export function useSnapshots(guest: GuestRef) {
  return useQuery({
    queryKey: ['snapshots', guest.conn, guest.node, guest.type, guest.vmid],
    queryFn: () => api.snapshots(guest),
  });
}

export function useSnapshotMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ guest, name, description, remove }: { guest: GuestData; name: string; description?: string; remove?: boolean }) => {
      const { upid } = remove ? await api.deleteSnapshot(guest, name) : await api.createSnapshot(guest, name, description);
      return assertOk(await api.waitForTask(guest.conn, guest.node, upid));
    },
    onMutate: ({ guest, name, remove }) => {
      toast.loading(`${remove ? 'Deleting' : 'Taking'} snapshot ${name} of ${guest.name}…`, { id: `snap-${guest.conn}-${guest.vmid}` });
    },
    onSuccess: (_t, { guest, name, remove }) => {
      toast.success(`Snapshot ${name} ${remove ? 'deleted' : 'created'} on ${guest.name}`, { id: `snap-${guest.conn}-${guest.vmid}` });
    },
    onError: (err, { guest }) => {
      toast.error(`${guest.name}: snapshot failed — ${err.message}`, { id: `snap-${guest.conn}-${guest.vmid}` });
    },
    onSettled: (_t, _e, { guest }) => qc.invalidateQueries({ queryKey: ['snapshots', guest.conn, guest.node, guest.type, guest.vmid] }),
  });
}
