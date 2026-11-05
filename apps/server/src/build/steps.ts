/** Building blocks shared by every deployment step. */
import { connect } from 'node:net';
import type { GuestType, StepStatus } from '@proxflow/shared';
import { PveError, type PveClient } from '../pve/client.js';
import type { RawAgentInterfaces } from '../pve/types.js';

export type StepGroup = 'restore' | 'upload' | 'create' | 'power' | 'wait' | 'cleanup' | 'download';
export type StepOutcome = { warning?: string; detail?: string } | void;

export interface StepContext {
  client: PveClient;
  node: string;
  mock: boolean;
  signal: AbortSignal;
  detail(text: string): void;
  progress(p: number | undefined): void;
  /** Abortable sleep; compressed against the mock so demos take seconds, not hours. */
  sleep(ms: number): Promise<void>;
  /** Real-world timeout, compressed against the mock. */
  timeout(ms: number): number;
  stepStatus(id: string): StepStatus | undefined;
  setMachine(id: string, patch: { ip?: string; message?: string }): void;
  /** Values shared between steps of one deployment (e.g. the VMID a restored template got). */
  shared: Map<string, unknown>;
  recordCreated(vmid: number, type: GuestType, name: string): void;
  recordUpload(volid: string): void;
  log(level: 'info' | 'warn' | 'error', msg: string): void;
}

export interface StepDef {
  id: string;
  machine?: string;
  title: string;
  deps: string[];
  group: StepGroup;
  run(ctx: StepContext): Promise<StepOutcome>;
}

export class AbortError extends Error {
  constructor() {
    super('cancelled');
    this.name = 'AbortError';
  }
}

export class StepTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepTimeout';
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortError());
    const onAbort = () => {
      clearTimeout(t);
      reject(new AbortError());
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export const fmtMinutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`);

const upidNode = (upid: string) => upid.split(':')[1] ?? '';

type TaskCtx = Pick<StepContext, 'client' | 'sleep' | 'timeout'> & Partial<Pick<StepContext, 'detail' | 'progress'>>;

/**
 * Waits for a Proxmox task. Proxmox returns a UPID for long operations (create, clone, restore,
 * download, delete…). Progress is scraped from the task log ("… 45%") when available.
 */
export async function waitForTask(ctx: TaskCtx, upid: unknown, opts: { what: string; timeoutMs?: number }): Promise<void> {
  if (typeof upid !== 'string' || !upid.startsWith('UPID:')) return; // synchronous call, nothing to wait for
  const node = upidNode(upid);
  const budget = opts.timeoutMs ?? 15 * 60_000;
  const deadline = Date.now() + ctx.timeout(budget);
  for (let n = 0; ; n++) {
    const t = await ctx.client.taskStatus(node, upid);
    if (t.status === 'stopped') {
      if (!t.exitstatus || t.exitstatus === 'OK' || t.exitstatus.startsWith('WARNINGS')) return;
      const tail = await ctx.client
        .taskLog(node, upid)
        .then((l) => l.map((x) => x.t).filter((s) => s && s !== 'TASK OK').slice(-2).join(' · '))
        .catch(() => '');
      throw new Error(`${opts.what} failed: ${t.exitstatus}${tail && !tail.includes(t.exitstatus) ? ` — ${tail}` : ''}`);
    }
    if (Date.now() > deadline) throw new StepTimeout(`${opts.what} is still running after ${fmtMinutes(budget)} — check the task in Proxmox`);
    if (ctx.progress && n % 2 === 1) {
      const lines = await ctx.client.taskLog(node, upid).catch(() => []);
      const last = [...lines].reverse().find((l) => /\d+(\.\d+)?%/.test(l.t));
      const m = last && /(\d+(?:\.\d+)?)%/.exec(last.t);
      if (m) ctx.progress(Math.min(1, Number(m[1]) / 100));
    }
    await ctx.sleep(1500);
  }
}

/** Calls fn until it returns a value, or throws StepTimeout. */
export async function pollUntil<T>(ctx: StepContext, fn: () => Promise<T | undefined>, opts: { intervalMs: number; timeoutMs: number; what: string }): Promise<T> {
  const deadline = Date.now() + ctx.timeout(opts.timeoutMs);
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new StepTimeout(`Timed out after ${fmtMinutes(opts.timeoutMs)} waiting for ${opts.what}`);
    await ctx.sleep(opts.intervalMs);
  }
}

export type AgentResult<T> =
  | { state: 'ok'; value: T }
  /** Agent not (yet) running, VM rebooting, file not written yet… — keep waiting. */
  | { state: 'waiting'; message: string }
  /** The API token lacks VM.Monitor / VM.GuestAgent.* — no point waiting. */
  | { state: 'denied'; message: string }
  /** The agent refuses the command (e.g. file access disabled in the guest). */
  | { state: 'unsupported'; message: string };

export async function agentCall<T>(fn: () => Promise<T>): Promise<AgentResult<T>> {
  try {
    return { state: 'ok', value: await fn() };
  } catch (e) {
    if (!(e instanceof PveError)) throw e;
    if (e.status === 403) return { state: 'denied', message: e.message };
    if (/disabled|blocked|not allowed|has been disabled|unsupported command/i.test(e.message)) return { state: 'unsupported', message: e.message };
    if (e.status >= 500 || e.isNetwork) return { state: 'waiting', message: e.message };
    throw e;
  }
}

export const AGENT_DENIED_HINT = 'Give the API token VM.Monitor (Proxmox 8) or the VM.GuestAgent.* privileges (Proxmox 9).';

/** First usable IPv4 from the agent, preferring the NIC with our MAC. */
export function pickIpv4(r: RawAgentInterfaces | undefined, mac?: string): string | undefined {
  const want = mac?.toLowerCase();
  const ifaces = [...(r?.result ?? [])].sort(
    (a, b) => Number(b['hardware-address']?.toLowerCase() === want) - Number(a['hardware-address']?.toLowerCase() === want),
  );
  for (const i of ifaces) {
    for (const a of i['ip-addresses'] ?? []) {
      const ip = a['ip-address'];
      if (a['ip-address-type'] === 'ipv4' && !ip.startsWith('127.') && !ip.startsWith('169.254.')) return ip;
    }
  }
  return undefined;
}

/** "stage=ready\ndetail=…" → { stage, detail } */
export function parseStatus(content: string | undefined): { stage?: string; detail?: string } {
  const out: Record<string, string> = {};
  for (const line of (content ?? '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { stage: out.stage, detail: out.detail };
}

/** True if something accepts TCP connections at host:port (used when a box has no guest agent). */
export function tcpProbe(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port });
    const done = (ok: boolean) => {
      clearTimeout(t);
      s.destroy();
      resolve(ok);
    };
    const t = setTimeout(() => done(false), timeoutMs);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * Is `port` open on the guest? Real Proxmox: a TCP connect from the ProxFlow server to the guest's IP.
 * Mock: the simulated lab IPs don't exist, so the mock reports simulated open ports in status/current.
 */
export async function probePort(ctx: StepContext, type: GuestType, vmid: number, ip: string, port: number): Promise<boolean> {
  if (ctx.mock) {
    const s = await ctx.client.guestStatus(ctx.node, type, vmid).catch(() => undefined);
    const ports = s?.['proxflow-mock-ports'];
    return Array.isArray(ports) && ports.includes(port);
  }
  return tcpProbe(ip, port);
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
