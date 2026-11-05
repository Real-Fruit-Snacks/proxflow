/**
 * Simulated guest behaviour for machines ProxFlow builds. It reads the SAME artifacts a real guest
 * would — the uploaded setup ISO (via the mock's own ISO reader) and the script written through the
 * guest agent — and walks through setup stages on a compressed clock (seconds, not minutes),
 * including reboots during which the agent is unreachable.
 */
import { volumes, type MockGuest } from './state.js';

export type SimRole = 'dc' | 'member' | 'standalone';
export type Sim = {
  kind: 'linux' | 'windows-iso' | 'windows-box' | 'esxi' | 'plain';
  agent: boolean;
  cloudInit: boolean;
  role?: SimRole;
  domain?: string;
  ip?: string;
  prefix?: number;
  bootedAt?: number;
  setupAt?: number; // windows box: when ProxFlow ran the setup script via the agent
  typed: string; // esxi: text typed with sendkey
  instance?: string; // echoed in the status file, like the real setup scripts do
  ksAt?: number;
};

const S = 1000;
// Timeline, in seconds (real installs take minutes; this keeps demos short).
const T = { linuxAgent: 4, linuxReady: 7, sshUp: 5, winAgent: 14, rdpUp: 16, boxAgent: 5, joinDur: 3, esxiInstall: 12 };
// DC: offsets from the start of its role phase.
const DC = { adds: 0, promote: 3, rebootFrom: 7, rebootTo: 10, startAd: 10, ready: 13 };

const DHCP_IP = (vmid: number) => `192.168.1.${100 + (vmid % 100)}`;

type SetupCfg = { instance?: string; role?: string; domain?: string; installDrivers?: boolean; net?: { static?: boolean; ip?: string; prefix?: number }; join?: { domain?: string } };

/** Pull the base64 JSON config out of ProxFlow's PowerShell setup script. */
function decodeSetup(script: string): SetupCfg | undefined {
  const m = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script);
  if (!m) return undefined;
  try {
    return JSON.parse(Buffer.from(m[1]!, 'base64').toString('utf8')) as SetupCfg;
  } catch {
    return undefined;
  }
}

const roleOf = (c: SetupCfg | undefined): SimRole => (c?.role === 'dc' ? 'dc' : c?.role === 'member' ? 'member' : 'standalone');

/** Called when a guest starts: work out what kind of machine it is from what's attached. */
export function initSim(g: MockGuest) {
  const cds = Object.values(g.config)
    .filter((v): v is string => typeof v === 'string' && v.includes('media=cdrom'))
    .map((v) => volumes.find((x) => x.volid === v.split(',')[0]))
    .filter((v) => v?.files);
  const files = cds[0]?.files;
  const prev = g.sim;
  const base = { typed: '', bootedAt: Date.now() };

  if (files?.joliet.has('user-data')) {
    const net = JSON.parse(files.joliet.get('network-config')?.toString() ?? '{}') as { ethernets?: Record<string, { addresses?: string[] }> };
    const addr = Object.values(net.ethernets ?? {})[0]?.addresses?.[0];
    const meta = JSON.parse(files.joliet.get('proxflow.json')?.toString() ?? '{}') as { domain?: string };
    const instance = /^instance-id:\s*(\S+)/m.exec(files.joliet.get('meta-data')?.toString() ?? '')?.[1];
    g.sim = {
      ...base,
      instance,
      kind: 'linux',
      agent: g.box?.agent ?? true,
      cloudInit: g.box?.cloudInit ?? true,
      domain: meta.domain,
      ip: addr ? addr.split('/')[0] : DHCP_IP(g.vmid),
      prefix: addr ? Number(addr.split('/')[1]) : 24,
    };
  } else if (files?.joliet.has('autounattend.xml')) {
    const cfg = decodeSetup(files.joliet.get('proxflow-setup.ps1')?.toString() ?? '');
    g.sim = {
      ...base,
      instance: cfg?.instance,
      kind: 'windows-iso',
      agent: Boolean(cfg?.installDrivers),
      cloudInit: false,
      role: roleOf(cfg),
      domain: cfg?.domain ?? cfg?.join?.domain,
      ip: cfg?.net?.static ? cfg.net.ip : DHCP_IP(g.vmid),
      prefix: cfg?.net?.prefix ?? 24,
    };
  } else if (files?.primary.has('KS.CFG')) {
    const ks = files.primary.get('KS.CFG')!.toString();
    g.sim = { ...base, kind: 'esxi', agent: false, cloudInit: false, ip: /--ip=(\S+)/.exec(ks)?.[1] };
  } else if (g.box?.os === 'windows') {
    // A Windows box keeps its settings across reboots; ProxFlow configures it via the agent after boot.
    g.sim = { ...(prev ?? {}), ...base, kind: 'windows-box', agent: g.box.agent, cloudInit: false, ip: prev?.ip ?? DHCP_IP(g.vmid), prefix: prev?.prefix ?? 24, setupAt: prev?.setupAt };
  } else if (prev) {
    g.sim = { ...prev, bootedAt: Date.now() };
  }
}

const sec = (g: MockGuest, from: number | undefined) => (from === undefined ? -1 : (Date.now() - from) / S);

/** When the DC for `domain` finished (or will finish) promotion. */
function dcReadyAt(domain: string | undefined, guests: MockGuest[]): number | undefined {
  if (!domain) return undefined;
  const times = guests
    .filter((x) => x.status === 'running' && x.sim?.role === 'dc' && x.sim.domain === domain)
    .map((x) => {
      const s = x.sim!;
      if (s.kind === 'windows-iso' && s.bootedAt) return s.bootedAt + (T.winAgent + DC.ready) * S;
      if (s.kind === 'windows-box' && s.setupAt) return s.setupAt + (4 + DC.ready) * S;
      return undefined;
    })
    .filter((t): t is number => t !== undefined);
  return times.length ? Math.min(...times) : undefined;
}

type Phase = { stage: string; detail: string; rebooting?: boolean } | null;

/** Role phase for Windows, `t` seconds after the role work began. */
function windowsRolePhase(s: Sim, t: number, roleStart: number, guests: MockGuest[]): Phase {
  if (s.role === 'dc') {
    if (t < DC.promote) return { stage: 'installing-adds', detail: 'Installing the AD DS role' };
    if (t < DC.rebootFrom) return { stage: 'promoting', detail: `Creating forest ${s.domain} - the VM reboots` };
    if (t < DC.rebootTo) return { stage: 'promoting', detail: 'rebooting', rebooting: true };
    if (t < DC.ready) return { stage: 'starting-ad', detail: 'Waiting for Active Directory services' };
    return { stage: 'ready', detail: `Domain ${s.domain} is up` };
  }
  if (s.role === 'member') {
    const dcReady = dcReadyAt(s.domain, guests);
    const now = Date.now();
    if (!dcReady || now < dcReady) return { stage: 'waiting-for-domain', detail: `Waiting for ${s.domain}` };
    const after = (now - Math.max(dcReady, roleStart)) / S;
    if (after < T.joinDur) return { stage: 'joining', detail: `Joining ${s.domain}` };
    if (after < T.joinDur + 2) return { stage: 'joining', detail: 'rebooting', rebooting: true };
    return { stage: 'ready', detail: `Joined ${s.domain}` };
  }
  return t < 1 ? { stage: 'identity', detail: 'Finishing setup' } : { stage: 'ready', detail: 'Windows is ready' };
}

function phase(g: MockGuest, guests: MockGuest[]): Phase {
  const s = g.sim;
  if (!s || g.status !== 'running') return null;
  const t = sec(g, s.bootedAt);
  switch (s.kind) {
    case 'linux': {
      if (!s.cloudInit) return null;
      if (t < T.linuxReady) return { stage: 'configuring', detail: 'cloud-init applied hostname, user and network' };
      if (!s.domain) return { stage: 'ready', detail: 'Ready' };
      const dcReady = dcReadyAt(s.domain, guests);
      if (!dcReady || Date.now() < dcReady) return { stage: 'waiting-for-domain', detail: `Waiting for ${s.domain} to come online` };
      const after = (Date.now() - Math.max(dcReady, s.bootedAt! + T.linuxReady * S)) / S;
      return after < T.joinDur ? { stage: 'joining', detail: `Joining ${s.domain}` } : { stage: 'ready', detail: `Joined ${s.domain}` };
    }
    case 'windows-iso':
      if (t < T.winAgent) return null; // Windows Setup still running
      return windowsRolePhase(s, t - T.winAgent, s.bootedAt! + T.winAgent * S, guests);
    case 'windows-box': {
      if (s.setupAt === undefined) return null;
      const st = sec(g, s.setupAt);
      if (st < 2) return { stage: 'identity', detail: 'Setting name, network and Administrator password' };
      if (st < 4) return { stage: 'identity', detail: 'rebooting', rebooting: true };
      return windowsRolePhase(s, st - 4, s.setupAt + 4 * S, guests);
    }
    default:
      return null;
  }
}

export function agentUp(g: MockGuest, guests: MockGuest[]): boolean {
  const s = g.sim;
  if (g.status !== 'running') return false;
  if (!s) return Boolean(g.config.agent) && String(g.config.agent).startsWith('1') || /enabled=1/.test(String(g.config.agent ?? ''));
  if (!s.agent) return false;
  const t = sec(g, s.bootedAt);
  const ready = s.kind === 'linux' ? T.linuxAgent : s.kind === 'windows-iso' ? T.winAgent : T.boxAgent;
  if (t < ready) return false;
  return !phase(g, guests)?.rebooting;
}

export function statusFile(g: MockGuest, guests: MockGuest[]): string | null {
  const p = phase(g, guests);
  if (!p || p.rebooting) return null;
  return `stage=${p.stage}\ndetail=${p.detail}\n${g.sim?.instance ? `instance=${g.sim.instance}\n` : ''}`;
}

export function openPorts(g: MockGuest, guests: MockGuest[]): number[] {
  const s = g.sim;
  if (!s || g.status !== 'running') return [];
  const t = sec(g, s.bootedAt);
  const p = phase(g, guests);
  if (p?.rebooting) return [];
  switch (s.kind) {
    case 'linux':
      return t >= T.sshUp ? [22] : [];
    case 'windows-iso':
    case 'windows-box': {
      // ISO installs switch RDP on as their last setup step; boxes do it while setting the identity.
      const rdp = s.kind === 'windows-iso' ? t >= T.rdpUp && p?.stage === 'ready' : t >= 8;
      const ports = rdp ? [3389] : [];
      if (s.role === 'dc' && p?.stage === 'ready') ports.push(389);
      // A DC built without the agent still finishes; expose LDAP on its timeline.
      if (s.role === 'dc' && !s.agent && s.kind === 'windows-iso' && t >= T.winAgent + DC.ready) ports.push(389);
      return ports;
    }
    case 'esxi':
      return s.ksAt && sec(g, s.ksAt) >= T.esxiInstall ? [443] : [];
    default:
      return [];
  }
}

export function guestIp(g: MockGuest): { ip: string; prefix: number } {
  return { ip: g.sim?.ip ?? DHCP_IP(g.vmid), prefix: g.sim?.prefix ?? 24 };
}

/** ProxFlow wrote the setup script into a Windows box through the agent. */
export function onFileWrite(g: MockGuest, content: string) {
  const cfg = decodeSetup(content);
  if (!cfg || !g.sim) return;
  g.sim.instance = cfg.instance;
  g.sim.role = roleOf(cfg);
  g.sim.domain = cfg.domain ?? cfg.join?.domain;
  if (cfg.net?.static && cfg.net.ip) {
    g.sim.ip = cfg.net.ip;
    g.sim.prefix = cfg.net.prefix ?? 24;
  }
}

/** ProxFlow ran the setup script through the agent. */
export function onExec(g: MockGuest, command: string[]) {
  if (g.sim && command.join(' ').includes('proxflow-setup.ps1')) g.sim.setupAt = Date.now();
}

const KEYS: Record<string, string> = { spc: ' ', equal: '=', 'shift-semicolon': ':', slash: '/', dot: '.', minus: '-', 'shift-minus': '_', ret: '\n' };

export function onSendKey(g: MockGuest, key: string) {
  if (!g.sim) return;
  const ch = KEYS[key] ?? (key.startsWith('shift-') && key.length === 7 ? key.slice(6).toUpperCase() : key.length === 1 ? key : '');
  g.sim.typed += ch;
  if (key === 'ret' && g.sim.typed.includes('ks=cdrom:/KS.CFG')) g.sim.ksAt = Date.now();
}
