/**
 * ESXi scripted install. The kickstart lives on a second CD as KS.CFG (8.3 upper-case name in the
 * primary ISO 9660 volume, which is what ESXi's installer reads). The installer only uses it when
 * booted with "ks=cdrom:/KS.CFG", which ProxFlow types at the boot menu via Proxmox's sendkey API.
 */
import { prefixToNetmask, type Cidr } from '@proxflow/shared';
import { buildIso } from '../../iso/iso9660.js';

export type EsxiOptions = { hostname: string; rootPassword: string; ip: string; cidr: Cidr; gateway?: string; dns: string[] };

export const ESXI_BOOT_APPEND = ' ks=cdrom:/KS.CFG';

export function esxiKickstart(o: EsxiOptions): string {
  const net = [
    'network --bootproto=static --device=vmnic0',
    `--ip=${o.ip}`,
    `--netmask=${prefixToNetmask(o.cidr.prefix)}`,
    o.gateway ? `--gateway=${o.gateway}` : '',
    o.dns.length ? `--nameserver=${o.dns.join(',')}` : '',
    `--hostname=${o.hostname}`,
    // No --vlanid: Proxmox already tags the VM's port (net0 tag=N) and strips the tag on the way in,
    // so ESXi tagging as well would put its management network on a VLAN nothing answers on.
  ]
    .filter(Boolean)
    .join(' ');
  return [
    '# Written by ProxFlow',
    'vmaccepteula',
    'install --firstdisk --overwritevmfs',
    `rootpw ${o.rootPassword}`,
    net,
    'reboot',
    '',
    '%firstboot --interpreter=busybox',
    'vim-cmd hostsvc/enable_ssh',
    'vim-cmd hostsvc/start_ssh',
    'vim-cmd hostsvc/enable_esx_shell',
    'vim-cmd hostsvc/start_esx_shell',
    'esxcli system settings advanced set -o /UserVars/SuppressShellWarning -i 1',
    '',
  ].join('\n');
}

export function esxiKickstartIso(o: EsxiOptions, meta: Record<string, unknown>): Buffer {
  return buildIso(
    [
      { name: 'KS.CFG', data: esxiKickstart(o) },
      { name: 'proxflow.json', data: JSON.stringify(meta, null, 2) },
    ],
    { volumeId: 'PFKS', jolietVolumeId: 'PFKS' },
  );
}

const KEY_NAMES: Record<string, string> = { ' ': 'spc', '=': 'equal', ':': 'shift-semicolon', '/': 'slash', '.': 'dot', '-': 'minus', _: 'shift-minus' };

/** Text → QEMU key names for PUT /nodes/{node}/qemu/{vmid}/sendkey. */
export function keysFor(text: string): string[] {
  return [...text].map((ch) => {
    if (/[a-z0-9]/.test(ch)) return ch;
    if (/[A-Z]/.test(ch)) return `shift-${ch.toLowerCase()}`;
    const k = KEY_NAMES[ch];
    if (!k) throw new Error(`No key mapping for "${ch}"`);
    return k;
  });
}
