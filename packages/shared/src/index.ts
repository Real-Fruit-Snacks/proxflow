/**
 * Shared contract between the API server and the web UI.
 *
 * Data shapes are declared as `type` aliases (not interfaces) on purpose:
 * @xyflow/react's `Node<Data>` requires `Data extends Record<string, unknown>`,
 * which interfaces don't satisfy without an index signature.
 */

// ───────────────────────── topology ─────────────────────────

export type GuestType = 'qemu' | 'lxc';
export type GuestStatus = 'running' | 'stopped' | 'paused' | 'suspended' | 'unknown';
export type NodeStatus = 'online' | 'offline' | 'unknown';

/** One Proxmox connection = one cluster (or one standalone node). */
export type ClusterInfo = {
  conn: string; // connection id
  connName: string;
  name: string;
  quorate: boolean;
  nodeCount: number;
  version?: string;
  mock?: boolean;
  ok: boolean;
  error?: string;
};

export type PveNodeData = {
  kind: 'node';
  conn: string;
  name: string;
  status: NodeStatus;
  cpu: number; // 0..1
  maxcpu: number;
  mem: number; // bytes
  maxmem: number;
  disk: number;
  maxdisk: number;
  uptime: number; // seconds
};

export type NetIface = {
  key: string; // net0, net1 …
  name?: string; // lxc: eth0
  bridge?: string;
  model?: string; // qemu: virtio, e1000 …
  mac?: string;
  vlan?: number;
  ip?: string; // lxc: 192.168.1.5/24 | dhcp
  gateway?: string;
  firewall?: boolean;
};

export type DiskRef = {
  key: string; // scsi0, rootfs, mp0 …
  storage: string;
  volume: string;
  sizeGiB?: number;
  mountPoint?: string;
};

export type GuestData = {
  kind: 'guest';
  conn: string;
  type: GuestType;
  vmid: number;
  name: string;
  node: string;
  status: GuestStatus;
  template: boolean;
  cpu: number; // 0..1
  maxcpu: number;
  mem: number;
  maxmem: number;
  maxdisk: number;
  uptime: number;
  tags: string[];
  ostype?: string;
  nets: NetIface[];
  disks: DiskRef[];
};

export type BridgeData = {
  kind: 'bridge';
  conn: string;
  name: string;
  node: string;
  cidr?: string;
  address?: string;
  gateway?: string;
  ports: string[];
  active: boolean;
  vlanAware: boolean;
};

export type StorageData = {
  kind: 'storage';
  conn: string;
  name: string;
  type: string; // dir, lvmthin, zfspool, nfs, pbs …
  nodes: string[];
  shared: boolean;
  content: string[];
  used: number;
  total: number;
  active: boolean;
};

export type TopoNodeData = PveNodeData | GuestData | BridgeData | StorageData;

export type TopoNode = { id: string; data: TopoNodeData };

export type EdgeKind = 'hosts' | 'net' | 'storage';

export type TopoEdge = {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  label?: string;
};

export type Topology = {
  clusters: ClusterInfo[];
  nodes: TopoNode[];
  edges: TopoEdge[];
  fetchedAt: string;
};

/** Stable graph IDs shared by server (producer) and web (consumer). Namespaced by connection. */
export const ids = {
  node: (conn: string, name: string) => `${conn}/node:${name}`,
  guest: (conn: string, vmid: number) => `${conn}/guest:${vmid}`,
  bridge: (conn: string, node: string, iface: string) => `${conn}/bridge:${node}/${iface}`,
  sharedStorage: (conn: string, name: string) => `${conn}/storage:${name}`,
  localStorage: (conn: string, node: string, name: string) => `${conn}/storage:${node}/${name}`,
};

// ───────────────────────── actions ─────────────────────────

export const GUEST_ACTIONS = ['start', 'stop', 'shutdown', 'reboot', 'suspend', 'resume'] as const;
export type GuestAction = (typeof GUEST_ACTIONS)[number];

export type TaskStatus = {
  upid: string;
  node: string;
  type: string;
  id?: string;
  user?: string;
  status: 'running' | 'stopped';
  exitstatus?: string;
  starttime: number;
};

export type Snapshot = {
  name: string;
  description?: string;
  snaptime?: number;
  parent?: string;
  vmstate?: boolean;
  current?: boolean;
};

export type ApiError = { error: string; status?: number; details?: unknown };

// ───────────────────────── connections ─────────────────────────

export type AuthInput =
  | { type: 'token'; tokenId: string; secret: string }
  | { type: 'password'; username: string; password: string };

/** Secrets never leave the server; the UI only sees which identity is configured. */
export type AuthPublic = { type: 'token'; tokenId: string } | { type: 'password'; username: string };

export type TlsMode = 'system' | 'pinned' | 'insecure';
export type TlsConfig = { mode: TlsMode; fingerprint?: string };

export type ConnectionInput = {
  name?: string;
  url: string;
  auth: AuthInput;
  tls?: TlsConfig;
  enabled?: boolean;
};

export type ConnectionStatus = {
  ok: boolean;
  checkedAt: string;
  version?: string;
  clusterName?: string;
  mock?: boolean;
  error?: string;
};

export type Connection = {
  id: string;
  name: string;
  url: string;
  auth: AuthPublic;
  tls: TlsConfig;
  enabled: boolean;
  createdAt: string;
  status?: ConnectionStatus;
};

export type PermissionLevel = 'unknown' | 'none' | 'read' | 'operate' | 'admin';

export type PermissionSummary = {
  known: boolean;
  level: PermissionLevel;
  vmsRead: boolean;
  nodesRead: boolean;
  storageRead: boolean;
  power: boolean;
  snapshot: boolean;
  clone: boolean;
  warnings: string[];
};

export type CertificateInfo = {
  fingerprint256: string; // AB:CD:… (same format Proxmox shows under System → Certificates)
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  altNames?: string;
  selfSigned: boolean;
};

export type ProbeErrorCode =
  | 'INVALID_URL'
  | 'UNREACHABLE'
  | 'TIMEOUT'
  | 'PROTOCOL'
  | 'TLS_UNTRUSTED'
  | 'TLS_FINGERPRINT_MISMATCH'
  | 'AUTH_FAILED'
  | 'NOT_PROXMOX'
  | 'HTTP_ERROR';

export type ProbeResult =
  | {
      ok: true;
      url: string;
      version: string;
      release: string;
      mock: boolean;
      cluster: { name: string; standalone: boolean; quorate: boolean };
      nodes: { name: string; online: boolean }[];
      permissions: PermissionSummary;
      tls: TlsConfig;
      certificate?: CertificateInfo;
    }
  | {
      ok: false;
      url: string;
      code: ProbeErrorCode;
      message: string;
      hint?: string;
      certificate?: CertificateInfo;
    };

export type HealthInfo = { ok: boolean; connections: number; connected: number };

// ───────────────────────── lab builder ─────────────────────────

export * from './ipv4';
export * from './lab-catalog';
export * from './lab-types';
export * from './lab-validate';
