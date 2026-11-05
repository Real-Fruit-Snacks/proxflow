/**
 * Built-in catalogs for the lab builder.
 *
 * ProxFlow is designed for offline (air-gapped) sites: labs are built from ISOs, disk images
 * ("boxes"), VM templates and container templates that are already on Proxmox storage.
 * The download catalog below is only an opt-in convenience for nodes that have internet access.
 */

export type OsFamily = 'debian' | 'rhel';

export type LinuxImageId = 'ubuntu-24.04' | 'ubuntu-22.04' | 'debian-13' | 'debian-12' | 'rocky-9' | 'alma-9';
export type LinuxImage = { label: string; url: string; filename: string; family: OsFamily };

/**
 * Official cloud images, downloaded straight onto Proxmox (download-url, content "import").
 * Filenames end in .qcow2 because Proxmox picks the disk format from the extension
 * (Ubuntu's ".img" files are qcow2 inside).
 */
export const LINUX_IMAGES: Record<LinuxImageId, LinuxImage> = {
  'ubuntu-24.04': {
    label: 'Ubuntu 24.04 LTS',
    url: 'https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img',
    filename: 'noble-server-cloudimg-amd64.qcow2',
    family: 'debian',
  },
  'ubuntu-22.04': {
    label: 'Ubuntu 22.04 LTS',
    url: 'https://cloud-images.ubuntu.com/jammy/current/jammy-server-cloudimg-amd64.img',
    filename: 'jammy-server-cloudimg-amd64.qcow2',
    family: 'debian',
  },
  'debian-13': {
    label: 'Debian 13 (trixie)',
    url: 'https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2',
    filename: 'debian-13-genericcloud-amd64.qcow2',
    family: 'debian',
  },
  'debian-12': {
    label: 'Debian 12 (bookworm)',
    url: 'https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2',
    filename: 'debian-12-genericcloud-amd64.qcow2',
    family: 'debian',
  },
  'rocky-9': {
    label: 'Rocky Linux 9',
    url: 'https://dl.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud-Base.latest.x86_64.qcow2',
    filename: 'Rocky-9-GenericCloud-Base.latest.x86_64.qcow2',
    family: 'rhel',
  },
  'alma-9': {
    label: 'AlmaLinux 9',
    url: 'https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2',
    filename: 'AlmaLinux-9-GenericCloud-latest.x86_64.qcow2',
    family: 'rhel',
  },
};

export type WindowsVersionId = '2019' | '2022' | '2025';
/** ostype is Proxmox's guest type; driverDir is the folder name on the VirtIO driver ISO. */
export const WINDOWS_VERSIONS: Record<WindowsVersionId, { label: string; ostype: string; driverDir: string }> = {
  '2019': { label: 'Windows Server 2019', ostype: 'win10', driverDir: '2k19' },
  '2022': { label: 'Windows Server 2022', ostype: 'win11', driverDir: '2k22' },
  '2025': { label: 'Windows Server 2025', ostype: 'win11', driverDir: '2k25' },
};

export type WindowsEditionId = 'standard-core' | 'standard-desktop' | 'datacenter-core' | 'datacenter-desktop';
/** Image index inside install.wim — this ordering holds for Microsoft's Server 2019/2022/2025 media. */
export const WINDOWS_EDITIONS: Record<WindowsEditionId, { label: string; index: number }> = {
  'standard-core': { label: 'Standard (Server Core)', index: 1 },
  'standard-desktop': { label: 'Standard (Desktop Experience)', index: 2 },
  'datacenter-core': { label: 'Datacenter (Server Core)', index: 3 },
  'datacenter-desktop': { label: 'Datacenter (Desktop Experience)', index: 4 },
};

/**
 * Readiness probes used when a guest has no QEMU guest agent (common offline: nothing to install it from).
 * ProxFlow connects to these ports on the machine's static IP.
 */
export const READY_PORTS = { linux: 22, windows: 3389, dc: 389, esxi: 443 } as const;

/** Heuristics for picking sensible defaults out of whatever is already on storage. */
export const looksLikeWindowsIso = (name: string) => /win|server|20348|26100|17763/i.test(name) && !/virtio/i.test(name);
export const looksLikeEsxiIso = (name: string) => /esxi|vmvisor|vmware/i.test(name);
export const looksLikeVirtioIso = (name: string) => /^virtio-win.*\.iso$/i.test(name);
export const guessFamily = (name: string): OsFamily => (/rocky|alma|rhel|centos|fedora|oracle|ol[89]/i.test(name) ? 'rhel' : 'debian');
/** Disk formats Proxmox can import directly from an Import-capable storage. */
export const isImportableDisk = (name: string) => /\.(qcow2|raw|vmdk|img)$/i.test(name);
