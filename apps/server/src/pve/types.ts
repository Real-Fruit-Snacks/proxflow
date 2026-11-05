/** Raw shapes as returned by Proxmox VE's /api2/json endpoints (subset we use). */

export interface RawResourceBase {
  id: string;
  type: 'node' | 'qemu' | 'lxc' | 'storage' | 'sdn' | 'pool';
  node?: string;
  status?: string;
  cpu?: number;
  maxcpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  uptime?: number;
}

export interface RawNodeResource extends RawResourceBase {
  type: 'node';
  node: string;
  level?: string;
}

export interface RawGuestResource extends RawResourceBase {
  type: 'qemu' | 'lxc';
  node: string;
  vmid: number;
  name?: string;
  template?: number;
  tags?: string;
  lock?: string;
  pool?: string;
}

export interface RawStorageResource extends RawResourceBase {
  type: 'storage';
  node: string;
  storage: string;
  shared?: number;
  content?: string;
  plugintype?: string;
}

export type RawResource =
  | RawNodeResource
  | RawGuestResource
  | RawStorageResource
  | (RawResourceBase & { type: 'sdn' | 'pool' });

export interface RawNetwork {
  iface: string;
  type: string; // bridge | eth | bond | vlan | OVSBridge | loopback …
  method?: string;
  cidr?: string;
  address?: string;
  gateway?: string;
  bridge_ports?: string;
  ovs_ports?: string;
  bridge_vlan_aware?: number;
  active?: number;
  autostart?: number;
}

export interface RawClusterStatus {
  type: 'cluster' | 'node';
  id: string;
  name: string;
  quorate?: number;
  nodes?: number;
  version?: number;
  online?: number;
  local?: number;
  ip?: string;
}

export interface RawVersion {
  version: string;
  release: string;
  repoid: string;
}

export interface RawTask {
  upid: string;
  node: string;
  pid: number;
  pstart: number;
  starttime: number;
  endtime?: number;
  type: string;
  id: string;
  user: string;
  status: 'running' | 'stopped';
  exitstatus?: string;
}

export interface RawSnapshot {
  name: string;
  description?: string;
  snaptime?: number;
  parent?: string;
  vmstate?: number;
  running?: number;
  digest?: string;
}

export interface RawTicket {
  ticket: string;
  CSRFPreventionToken: string;
  username: string;
  NeedTFA?: number;
}

/** GET /access/permissions → { "/": { "VM.Audit": 1, … }, "/vms/100": { … } } */
export type RawPermissions = Record<string, Record<string, number>>;

export type RawGuestConfig = Record<string, string | number | undefined>;

// ───── lab builder ─────

/** GET /nodes/{node}/storage */
export interface RawNodeStorage {
  storage: string;
  type: string;
  content: string;
  active?: number;
  enabled?: number;
  shared?: number;
  avail?: number;
  used?: number;
  total?: number;
}

/** GET /storage/{storage} */
export interface RawStorageConfig {
  storage: string;
  type: string;
  content?: string;
  digest?: string;
}

/** GET /nodes/{node}/storage/{storage}/content */
export interface RawVolume {
  volid: string;
  content: string;
  format?: string;
  size?: number;
  ctime?: number;
  vmid?: number;
  notes?: string;
  subtype?: string; // backups: qemu | lxc
}

export interface RawAgentInterfaces {
  result?: {
    name: string;
    'hardware-address'?: string;
    'ip-addresses'?: { 'ip-address': string; 'ip-address-type': 'ipv4' | 'ipv6'; prefix: number }[];
  }[];
}

export interface RawAgentExecStatus {
  exited: number | boolean;
  exitcode?: number;
  'out-data'?: string;
  'err-data'?: string;
}

export interface RawLxcInterface {
  name: string;
  hwaddr?: string;
  inet?: string;
  inet6?: string;
}

export interface RawTaskLogLine {
  n: number;
  t: string;
}
