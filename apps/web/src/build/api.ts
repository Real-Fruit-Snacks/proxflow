import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Deployment, LabPlan, LabSpec, PlanFix, TargetInventory } from '@proxflow/shared';
import { topologyKey } from '../api';

/** Like the map's fetch helper, but keeps the `plan` a rejected deploy returns. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly plan?: LabPlan,
  ) {
    super(message);
  }
}

async function http<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const b = body as { error?: string; plan?: LabPlan } | null;
    throw new ApiError(b?.error ?? `${res.status} ${res.statusText}`, res.status, b?.plan);
  }
  return body as T;
}

const enc = encodeURIComponent;
const RUNNING = new Set(['running', 'destroying']);

export const buildApi = {
  inventory: (conn: string, node?: string) => http<TargetInventory>(`/api/connections/${enc(conn)}/inventory${node ? `?node=${enc(node)}` : ''}`),
  plan: (spec: LabSpec) => http<LabPlan>('/api/labs/plan', { method: 'POST', body: JSON.stringify(spec) }),
  deploy: (spec: LabSpec) => http<Deployment>('/api/labs/deploy', { method: 'POST', body: JSON.stringify(spec) }),
  fix: (conn: string, fix: PlanFix) => http<{ ok: boolean }>('/api/labs/fix', { method: 'POST', body: JSON.stringify({ conn, fix }) }),
  deployment: (id: string) => http<Deployment>(`/api/labs/deployments/${enc(id)}`),
  cancel: (id: string) => http<Deployment>(`/api/labs/deployments/${enc(id)}/cancel`, { method: 'POST' }),
  destroy: (id: string) => http<Deployment>(`/api/labs/deployments/${enc(id)}/destroy`, { method: 'POST' }),
};

export const inventoryKey = (conn?: string, node?: string) => ['inventory', conn ?? '', node ?? ''] as const;

export function useInventory(conn?: string, node?: string) {
  return useQuery({
    queryKey: inventoryKey(conn, node),
    queryFn: () => buildApi.inventory(conn!, node),
    enabled: Boolean(conn),
    staleTime: 20_000,
    retry: 0,
  });
}

export function usePlan() {
  return useMutation({ mutationFn: buildApi.plan });
}

export function useDeploy() {
  return useMutation({ mutationFn: buildApi.deploy });
}

export function useFix() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ conn, fix }: { conn: string; fix: PlanFix }) => buildApi.fix(conn, fix),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['inventory'] }),
  });
}

/** Polls while the deployment is running; refreshes the map and inventory when it settles. */
export function useDeployment(id?: string) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ['deployment', id ?? ''],
    queryFn: async () => {
      const prev = qc.getQueryData<Deployment>(['deployment', id ?? '']);
      const d = await buildApi.deployment(id!);
      if (prev && RUNNING.has(prev.status) && !RUNNING.has(d.status)) {
        void qc.invalidateQueries({ queryKey: topologyKey });
        void qc.invalidateQueries({ queryKey: ['inventory'] });
      }
      // New VMs appear on the map while the lab builds.
      if (prev && d.created.length !== prev.created.length) void qc.invalidateQueries({ queryKey: topologyKey });
      return d;
    },
    enabled: Boolean(id),
    retry: 0,
    refetchInterval: (q) => (q.state.data && !RUNNING.has(q.state.data.status) ? false : 1500),
  });
}

export function useDeploymentAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'cancel' | 'destroy' }) => (action === 'cancel' ? buildApi.cancel(id) : buildApi.destroy(id)),
    onSuccess: (d) => qc.setQueryData(['deployment', d.id], d),
  });
}
