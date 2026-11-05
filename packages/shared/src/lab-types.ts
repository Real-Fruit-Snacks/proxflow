import type { GuestType, PermissionSummary } from './index';
import type { LinuxImageId, OsFamily, WindowsEditionId, WindowsVersionId } from './lab-catalog';

// ───────────────────────── what the user designs ─────────────────────────

export type MachineKind = 'linux-vm' | 'lxc' | 'windows' | 'esxi';
export type IpMode = 'dhcp' | 'static';

export type NetSpec = {
  bridge?: string; // empty = lab default
  vlan?: number;
  ipMode: IpMode;
  cidr?: string; // static: "192.168.1.200/24"
  gateway?: string;
  dns?: string; // comma-separated; empty = lab default
};

export type CredentialSpec = { username?: string; password?: string; sshKey?: string };

type MachineBase = {
  id: string;
  name: string;
  cores: number;
  memoryMiB: number;
  diskGiB: number;
  net: NetSpec;
  onboot: boolean;
  /** Per-machine overrides; empty fields fall back to the lab defaults. */
  credentials?: CredentialSpec;
};

export type LinuxSource =
  /** Clone an existing VM template (any node — cross-node works when its disks are on shared storage). */
  | { type: 'template'; vmid: number; family: OsFamily }
  /** A vzdump backup on storage (e.g. a share). Template backups are restored once into a template, then cloned. */
  | { type: 'backup'; volid: string; family: OsFamily }
  /** Existing disk image on any storage with Import content: qcow2 / raw / vmdk / img. */
  | { type: 'disk'; volid: string; family: OsFamily }
  /** Download an official cloud image — ONLY works if the Proxmox node has internet access. */
  | { type: 'catalog'; image: LinuxImageId };

export type LinuxVmSpec = MachineBase & {
  kind: 'linux-vm';
  source: LinuxSource;
  /** Extra packages for cloud-init to install — needs a reachable repo/mirror; empty by default (offline-safe). */
  packages: string[];
  joinDomainOf?: string;
};
export type LxcSource =
  /** Container template on storage, e.g. "share:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst". */
  | { type: 'vztmpl'; volid: string }
  /** A container (vzdump) backup on storage. */
  | { type: 'backup'; volid: string };
export type LxcSpec = MachineBase & { kind: 'lxc'; source: LxcSource; unprivileged: boolean; nesting: boolean };

export type WindowsRole = 'dc' | 'server';
export type WindowsSource =
  /** Unattended install from the installer ISO (fully automatic). */
  | { type: 'iso'; iso: string; version: WindowsVersionId; edition: WindowsEditionId; productKey?: string }
  /** Clone a Windows template / restore a backup. Configured through the guest agent if the box has it. */
  | { type: 'template'; vmid: number }
  | { type: 'backup'; volid: string };
export type WindowsSpec = MachineBase & {
  kind: 'windows';
  role: WindowsRole;
  source: WindowsSource;
  domain?: { fqdn: string; netbios: string }; // role "dc"
  joinDomainOf?: string; // role "server": id of a DC in this lab
};
export type EsxiSpec = MachineBase & { kind: 'esxi'; iso: string };

export type MachineSpec = LinuxVmSpec | LxcSpec | WindowsSpec | EsxiSpec;

export type LabTarget = {
  conn: string;
  node: string;
  diskStorage: string; // VM disks / container root filesystems
  isoStorage: string; // where ProxFlow uploads its small setup ISOs (and downloads ISOs if needed)
  importStorage: string; // where catalog cloud images are downloaded to
  bridge: string; // default network
};

export type LabDefaults = { username: string; password: string; sshKey: string; dns: string };

export type LabSpec = { name: string; target: LabTarget; defaults: LabDefaults; machines: MachineSpec[] };

// ───────────────────────── what's on the target ─────────────────────────

export type InventoryStorage = { name: string; type: string; content: string[]; avail: number; total: number; shared: boolean; active: boolean };
export type InventoryBridge = { name: string; cidr?: string; gateway?: string; vlanAware: boolean };
export type InventoryVolume = { volid: string; storage: string; name: string; size: number; shared: boolean };
/** `box` = a template ProxFlow restored from a backup on storage (tagged pf-box). */
export type InventoryTemplate = { vmid: number; name: string; node: string; type: GuestType; box: boolean };
/** A vzdump backup. `template` is read from the backup's embedded config (true = restores as a template). */
export type InventoryBackup = InventoryVolume & { subtype: GuestType; vmid?: number; ctime?: number; notes?: string; template?: boolean };

export type TargetInventory = {
  conn: string;
  node: string;
  version: string;
  mock: boolean;
  nodes: { name: string; online: boolean; maxcpu: number; maxmem: number; mem: number }[];
  features: { importImages: boolean };
  storages: InventoryStorage[];
  bridges: InventoryBridge[];
  /** Every ISO the node can attach — local and shared storages alike. */
  isos: InventoryVolume[];
  /** Disk images on Import-capable storages: community boxes, previously downloaded cloud images… */
  diskImages: InventoryVolume[];
  lxcTemplates: InventoryVolume[];
  /** VM and container templates anywhere in the cluster. */
  vmTemplates: InventoryTemplate[];
  /** vzdump backups on any storage the node can see (shares included) — "boxes" distributed as backups. */
  backups: InventoryBackup[];
  /** First VirtIO driver ISO found on any storage; without it Windows uses built-in SATA + Intel NIC drivers. */
  virtioIso?: string;
  usedVmids: number[];
  usedNames: string[];
  usedIps: string[];
  nextId: number;
  permissions: PermissionSummary;
};

// ───────────────────────── what the server plans ─────────────────────────

export type PlanFix = { kind: 'enable-content'; storage: string; content: string; label: string };
export type LabIssue = { level: 'error' | 'warning'; message: string; machine?: string; field?: string; fix?: PlanFix };

export type PlannedMachine = {
  id: string;
  name: string;
  kind: MachineKind;
  label: string;
  vmid: number;
  type: GuestType;
  mac: string;
  ip?: string;
  summary: string;
  access: string[];
  /** How ProxFlow will know the machine is ready, e.g. "guest agent" or "SSH on 10.0.0.5:22". */
  readiness: string;
};

export type PlannedAsset = { id: string; label: string; volid: string; action: 'reuse' | 'download' | 'upload'; detail?: string };
export type PlanStepInfo = { id: string; machine?: string; title: string; deps: string[] };

export type LabPlan = {
  ok: boolean;
  issues: LabIssue[];
  machines: PlannedMachine[];
  assets: PlannedAsset[];
  steps: PlanStepInfo[];
  estimateMinutes: number;
  mock: boolean;
};

// ───────────────────────── what a deployment reports ─────────────────────────

export type StepStatus = 'pending' | 'running' | 'done' | 'warning' | 'failed' | 'skipped' | 'cancelled';
export type DeploymentStep = PlanStepInfo & {
  status: StepStatus;
  detail?: string;
  error?: string;
  progress?: number;
  startedAt?: string;
  endedAt?: string;
};

export type MachineStatus = 'pending' | 'building' | 'ready' | 'warning' | 'failed' | 'cancelled';
export type DeploymentMachine = PlannedMachine & { status: MachineStatus; message?: string; done: number; total: number };

export type DeploymentStatus = 'running' | 'succeeded' | 'warning' | 'failed' | 'cancelled' | 'interrupted' | 'destroying' | 'destroyed';
export type DeploymentLogEntry = { t: string; level: 'info' | 'warn' | 'error'; msg: string };

export type Deployment = {
  id: string;
  labName: string;
  conn: string;
  connName: string;
  node: string;
  mock: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  status: DeploymentStatus;
  machines: DeploymentMachine[];
  steps: DeploymentStep[];
  log: DeploymentLogEntry[];
  /** Guests and volumes this deployment created — what "Destroy lab" removes. */
  created: { vmid: number; type: GuestType; name: string }[];
  uploaded: string[];
};
