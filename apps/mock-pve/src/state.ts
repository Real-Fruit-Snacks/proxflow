/**
 * In-memory "cluster" behind the mock Proxmox API.
 * Shapes here are the mock's own; routes.ts translates them into /api2/json responses.
 */

export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
export const TiB = 1024 ** 4;
export const USER = 'root@pam!proxflow';
export const CLUSTER_NAME = 'homelab';

export type GuestType = 'qemu' | 'lxc';
export type GuestStatus = 'running' | 'stopped';

export interface MockSnapshot {
  name: string;
  description: string;
  snaptime: number;
  parent?: string;
  vmstate: boolean;
}

export interface MockGuest {
  type: GuestType;
  vmid: number;
  node: string;
  name: string;
  status: GuestStatus;
  template: boolean;
  cores: number;
  memoryMiB: number;
  maxdisk: number;
  ostype: string;
  tags: string[];
  config: Record<string, string | number>;
  startedAt: number | null;
  baseCpu: number;
  cpu: number;
  mem: number;
  snapshots: MockSnapshot[];
  /** What's inside the image — lets the mock exercise both "has agent/cloud-init" and "has neither" paths. */
  box?: BoxCaps;
  /** Simulated in-guest progress for guests ProxFlow builds (see sim.ts). */
  sim?: import('./sim.js').Sim;
}

export type BoxCaps = { os: 'linux' | 'windows'; agent: boolean; cloudInit: boolean };

export interface MockVolume {
  volid: string;
  storage: string;
  /** Local storages: the node the file lives on. Shared storages: undefined (visible from every node). */
  node?: string;
  content: 'iso' | 'vztmpl' | 'backup' | 'import';
  size: number;
  ctime: number;
  notes?: string;
  /** Backups: guest type, the config embedded in the archive, and what's inside the image. */
  subtype?: GuestType;
  backupConfig?: string;
  box?: BoxCaps;
  /** Import images: virtual disk size in bytes. */
  virtualSize?: number;
  /** ISOs uploaded by ProxFlow, parsed by the mock's own ISO reader. */
  files?: import('./iso.js').IsoContents;
}

export interface MockNode {
  name: string;
  nodeid: number;
  ip: string;
  status: 'online' | 'offline';
  maxcpu: number;
  maxmem: number;
  maxdisk: number;
  disk: number;
  bootedAt: number;
  cpu: number;
  mem: number;
}

export interface MockStorage {
  name: string;
  type: string;
  nodes: string[];
  shared: boolean;
  content: string[];
  total: number;
  used: number;
}

export interface MockBridge {
  node: string;
  iface: string;
  cidr?: string;
  address?: string;
  gateway?: string;
  ports: string[];
  vlanAware: boolean;
}

export interface MockTask {
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
  log: string[];
}

const NOW = Date.now();
const daysAgo = (d: number) => NOW - d * 86_400_000;
const hex2 = (n: number) => (n & 0xff).toString(16).padStart(2, '0').toUpperCase();

export const mac = (vmid: number, nic: number) => `BC:24:11:${hex2(vmid >> 8)}:${hex2(vmid)}:${hex2(nic)}`;

const vmNet = (vmid: number, nic: number, bridge: string, extra?: string) =>
  [`virtio=${mac(vmid, nic)}`, `bridge=${bridge}`, 'firewall=1', extra].filter(Boolean).join(',');

const ctNet = (vmid: number, nic: number, bridge: string, ip = 'dhcp', extra?: string) =>
  [`name=eth${nic}`, `bridge=${bridge}`, `hwaddr=${mac(vmid, nic)}`, `ip=${ip}`, 'type=veth', extra]
    .filter(Boolean)
    .join(',');

export const nodes: MockNode[] = [
  {
    name: 'pve1',
    nodeid: 1,
    ip: '192.168.1.10',
    status: 'online',
    maxcpu: 16,
    maxmem: 64 * GiB,
    maxdisk: 465 * GiB,
    disk: 180 * GiB,
    bootedAt: daysAgo(23.4),
    cpu: 0,
    mem: 0,
  },
  {
    name: 'pve2',
    nodeid: 2,
    ip: '192.168.1.11',
    status: 'online',
    maxcpu: 8,
    maxmem: 32 * GiB,
    maxdisk: 232 * GiB,
    disk: 70 * GiB,
    bootedAt: daysAgo(9.1),
    cpu: 0,
    mem: 0,
  },
];

export const bridges: MockBridge[] = [
  {
    node: 'pve1',
    iface: 'vmbr0',
    cidr: '192.168.1.10/24',
    address: '192.168.1.10',
    gateway: '192.168.1.1',
    ports: ['eno1'],
    vlanAware: true,
  },
  { node: 'pve1', iface: 'vmbr1', cidr: '10.0.0.1/24', address: '10.0.0.1', ports: [], vlanAware: false },
  {
    node: 'pve2',
    iface: 'vmbr0',
    cidr: '192.168.1.11/24',
    address: '192.168.1.11',
    gateway: '192.168.1.1',
    ports: ['eno1'],
    vlanAware: true,
  },
];

export const storages: MockStorage[] = [
  { name: 'local', type: 'dir', nodes: ['pve1'], shared: false, content: ['iso', 'vztmpl', 'backup'], total: 100 * GiB, used: 23 * GiB },
  { name: 'local', type: 'dir', nodes: ['pve2'], shared: false, content: ['iso', 'vztmpl', 'backup'], total: 100 * GiB, used: 11 * GiB },
  { name: 'local-lvm', type: 'lvmthin', nodes: ['pve1'], shared: false, content: ['images', 'rootdir'], total: 350 * GiB, used: 142 * GiB },
  { name: 'local-lvm', type: 'lvmthin', nodes: ['pve2'], shared: false, content: ['images', 'rootdir'], total: 130 * GiB, used: 48 * GiB },
  { name: 'nas-nfs', type: 'nfs', nodes: ['pve1', 'pve2'], shared: true, content: ['images', 'rootdir', 'backup', 'iso'], total: 4 * TiB, used: 1.7 * TiB },
  { name: 'pbs', type: 'pbs', nodes: ['pve1', 'pve2'], shared: true, content: ['backup'], total: 2 * TiB, used: 0.9 * TiB },
  // Like the user's work setup: a share with installer ISOs, community "boxes" (backups) and templates.
  { name: 'share', type: 'nfs', nodes: ['pve1', 'pve2'], shared: true, content: ['iso', 'vztmpl', 'backup', 'import'], total: 8 * TiB, used: 2.3 * TiB },
];

const ago = (days: number) => Math.floor(daysAgo(days) / 1000);

const qemuBackupConfig = (name: string, ostype: string, extra: string[] = []) =>
  [`name: ${name}`, 'template: 1', 'cores: 2', 'memory: 2048', `ostype: ${ostype}`, 'scsihw: virtio-scsi-single', 'net0: virtio=BC:24:11:00:00:01,bridge=vmbr0', 'boot: order=scsi0', ...extra].join('\n') + '\n';

/** Pre-seeded storage content. ProxFlow-uploaded ISOs and downloads are added at runtime. */
export const volumes: MockVolume[] = [
  // ── share: installer ISOs
  { volid: 'share:iso/SERVER_EVAL_x64FRE_en-us.iso', storage: 'share', content: 'iso', size: 4_900 * MiB, ctime: ago(200) },
  { volid: 'share:iso/26100.1742.240906-0331.ge_release_svc_refresh_SERVER_EVAL_x64FRE_en-us.iso', storage: 'share', content: 'iso', size: 5_600 * MiB, ctime: ago(60) },
  { volid: 'share:iso/virtio-win-0.1.266.iso', storage: 'share', content: 'iso', size: 710 * MiB, ctime: ago(90) },
  { volid: 'share:iso/VMware-VMvisor-Installer-8.0U3-24022510.x86_64.iso', storage: 'share', content: 'iso', size: 600 * MiB, ctime: ago(120) },
  { volid: 'share:iso/ubuntu-24.04.1-live-server-amd64.iso', storage: 'share', content: 'iso', size: 2_700 * MiB, ctime: ago(100) },
  // ── share: community boxes distributed as vzdump backups of templates
  {
    volid: 'share:backup/vzdump-qemu-9100-2025_09_14-10_00_00.vma.zst', storage: 'share', content: 'backup', subtype: 'qemu', size: 1_400 * MiB, ctime: ago(50),
    notes: 'rocky9-box (cloud-init + guest agent)', backupConfig: qemuBackupConfig('rocky9-box', 'l26', ['agent: 1', 'scsi0: local-lvm:base-9100-disk-0,size=10G', 'ide2: local-lvm:vm-9100-cloudinit,media=cdrom']),
    box: { os: 'linux', agent: true, cloudInit: true },
  },
  {
    volid: 'share:backup/vzdump-qemu-9101-2025_09_20-11_30_00.vma.zst', storage: 'share', content: 'backup', subtype: 'qemu', size: 9_800 * MiB, ctime: ago(44),
    notes: 'win2022-box (sysprepped, VirtIO tools)', backupConfig: qemuBackupConfig('win2022-box', 'win11', ['agent: 1', 'machine: pc-q35-8.1', 'scsi0: local-lvm:base-9101-disk-0,size=40G']),
    box: { os: 'windows', agent: true, cloudInit: false },
  },
  {
    volid: 'share:backup/vzdump-qemu-9102-2025_06_02-08_15_00.vma.zst', storage: 'share', content: 'backup', subtype: 'qemu', size: 1_100 * MiB, ctime: ago(150),
    notes: 'centos7-legacy-box (cloud-init, NO guest agent)', backupConfig: qemuBackupConfig('centos7-legacy-box', 'l26', ['scsi0: local-lvm:base-9102-disk-0,size=8G']),
    box: { os: 'linux', agent: false, cloudInit: true },
  },
  {
    volid: 'share:backup/vzdump-lxc-9200-2025_08_01-09_00_00.tar.zst', storage: 'share', content: 'backup', subtype: 'lxc', size: 180 * MiB, ctime: ago(95),
    notes: 'alpine-tools-ct', backupConfig: ['hostname: alpine-tools', 'template: 1', 'cores: 1', 'memory: 256', 'rootfs: local-lvm:base-9200-disk-0,size=2G', 'ostype: alpine'].join('\n') + '\n',
  },
  // ── share: container templates and a disk image
  { volid: 'share:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst', storage: 'share', content: 'vztmpl', size: 120 * MiB, ctime: ago(200) },
  { volid: 'share:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst', storage: 'share', content: 'vztmpl', size: 140 * MiB, ctime: ago(180) },
  { volid: 'share:import/debian-12-box.qcow2', storage: 'share', content: 'import', size: 420 * MiB, ctime: ago(70), virtualSize: 3 * GiB, box: { os: 'linux', agent: true, cloudInit: true } },
  // ── node-local
  { volid: 'local:vztmpl/alpine-3.20-default_20240908_amd64.tar.xz', storage: 'local', node: 'pve1', content: 'vztmpl', size: 3 * MiB, ctime: ago(300) },
];

interface GuestSpec {
  type: GuestType;
  vmid: number;
  node: string;
  name: string;
  status?: GuestStatus;
  template?: boolean;
  cores: number;
  memoryMiB: number;
  maxdiskGiB: number;
  ostype: string;
  tags?: string[];
  baseCpu?: number;
  config: Record<string, string | number>;
  snapshots?: MockSnapshot[];
  box?: BoxCaps;
}

function defineGuest(s: GuestSpec): MockGuest {
  const status: GuestStatus = s.template ? 'stopped' : (s.status ?? 'running');
  const g: MockGuest = {
    type: s.type,
    vmid: s.vmid,
    node: s.node,
    name: s.name,
    status,
    template: !!s.template,
    cores: s.cores,
    memoryMiB: s.memoryMiB,
    maxdisk: s.maxdiskGiB * GiB,
    ostype: s.ostype,
    tags: s.tags ?? [],
    config: s.config,
    startedAt: status === 'running' ? daysAgo(Math.random() * 8 + 0.2) : null,
    baseCpu: s.baseCpu ?? 0.08,
    box: s.box,
    cpu: 0,
    mem: 0,
    snapshots: s.snapshots ?? [],
  };
  g.cpu = status === 'running' ? g.baseCpu : 0;
  g.mem = status === 'running' ? g.memoryMiB * MiB * 0.45 : 0;
  return g;
}

export const guests: MockGuest[] = [
  // ───── pve1 ─────
  defineGuest({
    type: 'qemu', vmid: 9000, node: 'pve1', name: 'ubuntu-cloud-template', template: true, box: { os: 'linux', agent: true, cloudInit: true },
    cores: 2, memoryMiB: 2048, maxdiskGiB: 10, ostype: 'l26', tags: ['template'],
    config: {
      scsi0: 'local-lvm:base-9000-disk-0,size=10G',
      ide2: 'local-lvm:vm-9000-cloudinit,media=cdrom',
      net0: vmNet(9000, 0, 'vmbr0'),
      ciuser: 'ubuntu',
    },
  }),
  defineGuest({
    type: 'qemu', vmid: 100, node: 'pve1', name: 'win11-desktop', status: 'stopped',
    cores: 4, memoryMiB: 8192, maxdiskGiB: 120, ostype: 'win11', tags: ['desktop'],
    config: {
      scsi0: 'local-lvm:vm-100-disk-0,size=120G,cache=writeback,discard=on',
      efidisk0: 'local-lvm:vm-100-disk-1,efitype=4m,pre-enrolled-keys=1,size=4M',
      tpmstate0: 'local-lvm:vm-100-disk-2,size=4M,version=v2.0',
      ide2: 'local:iso/virtio-win.iso,media=cdrom',
      net0: vmNet(100, 0, 'vmbr0'),
      bios: 'ovmf',
      machine: 'pc-q35-8.1',
    },
    snapshots: [{ name: 'clean-install', description: 'Fresh Windows install, drivers loaded', snaptime: Math.floor(daysAgo(40) / 1000), vmstate: false }],
  }),
  defineGuest({
    type: 'qemu', vmid: 101, node: 'pve1', name: 'docker-host',
    cores: 4, memoryMiB: 8192, maxdiskGiB: 564, ostype: 'l26', tags: ['prod', 'docker'], baseCpu: 0.22,
    config: {
      scsi0: 'local-lvm:vm-101-disk-0,size=64G,discard=on',
      scsi1: 'nas-nfs:vm-101-disk-1,size=500G',
      net0: vmNet(101, 0, 'vmbr0'),
      agent: '1',
    },
    snapshots: [
      { name: 'pre-upgrade', description: 'Before docker 27 upgrade', snaptime: Math.floor(daysAgo(12) / 1000), vmstate: false },
      { name: 'post-upgrade', description: '', snaptime: Math.floor(daysAgo(11.9) / 1000), parent: 'pre-upgrade', vmstate: true },
    ],
  }),
  defineGuest({
    type: 'qemu', vmid: 102, node: 'pve1', name: 'k3s-master',
    cores: 4, memoryMiB: 8192, maxdiskGiB: 40, ostype: 'l26', tags: ['k8s', 'prod'], baseCpu: 0.31,
    config: {
      scsi0: 'local-lvm:vm-102-disk-0,size=40G,discard=on',
      net0: vmNet(102, 0, 'vmbr0', 'tag=20'),
      agent: '1',
    },
  }),
  defineGuest({
    type: 'qemu', vmid: 103, node: 'pve1', name: 'pfsense',
    cores: 2, memoryMiB: 4096, maxdiskGiB: 16, ostype: 'other', tags: ['network'], baseCpu: 0.05,
    config: {
      scsi0: 'local-lvm:vm-103-disk-0,size=16G',
      net0: vmNet(103, 0, 'vmbr0'),
      net1: vmNet(103, 1, 'vmbr1'),
      onboot: 1,
      startup: 'order=1',
    },
  }),
  defineGuest({
    type: 'lxc', vmid: 200, node: 'pve1', name: 'pihole',
    cores: 1, memoryMiB: 512, maxdiskGiB: 4, ostype: 'debian', tags: ['dns', 'prod'], baseCpu: 0.03,
    config: {
      rootfs: 'local-lvm:vm-200-disk-0,size=4G',
      net0: ctNet(200, 0, 'vmbr0', '192.168.1.53/24', 'gw=192.168.1.1'),
      onboot: 1,
    },
  }),
  defineGuest({
    type: 'lxc', vmid: 201, node: 'pve1', name: 'nginx-proxy',
    cores: 2, memoryMiB: 1024, maxdiskGiB: 8, ostype: 'alpine', tags: ['prod'], baseCpu: 0.06,
    config: {
      rootfs: 'local-lvm:vm-201-disk-0,size=8G',
      net0: ctNet(201, 0, 'vmbr0'),
      onboot: 1,
    },
  }),
  defineGuest({
    type: 'lxc', vmid: 202, node: 'pve1', name: 'gitea', status: 'stopped',
    cores: 2, memoryMiB: 2048, maxdiskGiB: 216, ostype: 'debian', tags: ['dev'],
    config: {
      rootfs: 'local-lvm:vm-202-disk-0,size=16G',
      mp0: 'nas-nfs:subvol-202-disk-0,mp=/data,size=200G',
      net0: ctNet(202, 0, 'vmbr0'),
    },
  }),

  // ───── pve2 ─────
  // A Windows box template living on pve2 with its disk on shared storage → clonable to pve1.
  defineGuest({
    type: 'qemu', vmid: 9001, node: 'pve2', name: 'win2022-template', template: true, box: { os: 'windows', agent: true, cloudInit: false },
    cores: 2, memoryMiB: 4096, maxdiskGiB: 40, ostype: 'win11', tags: ['template'],
    config: {
      scsi0: 'nas-nfs:base-9001-disk-0,size=40G',
      net0: vmNet(9001, 0, 'vmbr0'),
      machine: 'pc-q35-8.1',
      agent: '1',
    },
  }),
  defineGuest({
    type: 'qemu', vmid: 110, node: 'pve2', name: 'k3s-worker-1',
    cores: 4, memoryMiB: 8192, maxdiskGiB: 40, ostype: 'l26', tags: ['k8s', 'prod'], baseCpu: 0.45,
    config: {
      scsi0: 'local-lvm:vm-110-disk-0,size=40G,discard=on',
      net0: vmNet(110, 0, 'vmbr0', 'tag=20'),
      agent: '1',
    },
  }),
  defineGuest({
    type: 'qemu', vmid: 111, node: 'pve2', name: 'homeassistant',
    cores: 2, memoryMiB: 4096, maxdiskGiB: 32, ostype: 'l26', tags: ['home'], baseCpu: 0.12,
    config: {
      scsi0: 'local-lvm:vm-111-disk-0,size=32G',
      net0: vmNet(111, 0, 'vmbr0'),
      usb0: 'host=10c4:ea60',
      onboot: 1,
    },
  }),
  defineGuest({
    type: 'lxc', vmid: 210, node: 'pve2', name: 'postgres',
    cores: 2, memoryMiB: 4096, maxdiskGiB: 20, ostype: 'debian', tags: ['db', 'prod'], baseCpu: 0.18,
    config: {
      rootfs: 'local-lvm:vm-210-disk-0,size=20G',
      net0: ctNet(210, 0, 'vmbr0', '192.168.1.60/24', 'gw=192.168.1.1'),
      onboot: 1,
    },
  }),
  defineGuest({
    type: 'lxc', vmid: 211, node: 'pve2', name: 'minio',
    cores: 2, memoryMiB: 2048, maxdiskGiB: 1032, ostype: 'debian', tags: ['storage'], baseCpu: 0.07,
    config: {
      rootfs: 'local-lvm:vm-211-disk-0,size=8G',
      mp0: 'nas-nfs:subvol-211-disk-0,mp=/srv/minio,size=1T',
      net0: ctNet(211, 0, 'vmbr0'),
    },
  }),
];

export const tasks = new Map<string, MockTask>();

let pidCounter = 4200;
const hex8 = (n: number) => (n >>> 0).toString(16).toUpperCase().padStart(8, '0');

/**
 * Mimics a Proxmox task: returns a UPID immediately, applies `work` after `delayMs`.
 * With `progressOf`, the task log gets "… NN%" lines like real download/restore tasks.
 */
export function runTask(node: string, type: string, id: string, work: () => string | void, delayMs = 1500, progressOf?: string): MockTask {
  const starttime = Math.floor(Date.now() / 1000);
  const pid = pidCounter++;
  const pstart = Math.floor(Math.random() * 0xffffffff);
  const upid = `UPID:${node}:${hex8(pid)}:${hex8(pstart)}:${hex8(starttime)}:${type}:${id}:${USER}:`;
  const task: MockTask = { upid, node, pid, pstart, starttime, type, id, user: USER, status: 'running', log: [`starting ${type} ${id}`] };
  tasks.set(upid, task);
  // A long demo session runs thousands of tasks: keep the newest, like Proxmox's own task list.
  if (tasks.size > 2000) for (const [k, t] of tasks) if (t.status !== 'running' && tasks.size > 1500) tasks.delete(k);
  if (progressOf) {
    for (const pct of [20, 45, 70, 95]) setTimeout(() => task.status === 'running' && task.log.push(`${progressOf}: ${pct}%`), (delayMs * pct) / 100);
  }
  setTimeout(() => {
    let err: string | undefined;
    try {
      err = work() || undefined;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    task.exitstatus = err ?? 'OK';
    task.log.push(err ? `TASK ERROR: ${err}` : 'TASK OK');
    task.status = 'stopped';
    task.endtime = Math.floor(Date.now() / 1000);
  }, delayMs);
  return task;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Jitters live metrics so the UI has something to animate. */
export function tick() {
  for (const g of guests) {
    if (g.status !== 'running') {
      g.cpu = 0;
      g.mem = 0;
      continue;
    }
    const max = g.memoryMiB * MiB;
    g.cpu = clamp(g.baseCpu + (Math.random() - 0.5) * 0.1, 0.005, 0.98);
    const target = max * clamp(0.3 + g.baseCpu, 0.2, 0.9);
    g.mem = clamp(g.mem + (target - g.mem) * 0.15 + (Math.random() - 0.5) * 0.04 * max, 0.1 * max, 0.95 * max);
  }
  for (const n of nodes) {
    const running = guests.filter((g) => g.node === n.name && g.status === 'running');
    const load = running.reduce((acc, g) => acc + g.cpu * g.cores, 0) / n.maxcpu;
    n.cpu = clamp(0.015 + load + (Math.random() - 0.5) * 0.01, 0, 1);
    n.mem = 2.5 * GiB + running.reduce((acc, g) => acc + g.mem, 0);
  }
}
tick();
