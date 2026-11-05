/**
 * NoCloud seed ISO (label "cidata") for Linux VMs built from boxes, templates or cloud images.
 * Offline-safe: no package refresh or installs unless the user explicitly lists packages.
 * Progress is written to /var/lib/proxflow/status, which ProxFlow reads via the guest agent if present.
 */
import type { OsFamily } from '@proxflow/shared';
import { buildIso } from '../../iso/iso9660.js';

export type LinuxNet = { static: boolean; cidr?: string; gateway?: string; dns: string[]; search?: string; overrideDhcpDns?: boolean };

export type LinuxSeedOptions = {
  instanceId: string;
  hostname: string;
  fqdn?: string;
  username: string;
  password?: string;
  sshKeys: string[];
  mac: string; // "bc:24:11:…"
  net: LinuxNet;
  family: OsFamily;
  packages: string[];
  join?: { domain: string; password: string };
  meta: Record<string, unknown>;
};

/** Single-quote for POSIX sh. */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function finishScript(o: LinuxSeedOptions): string {
  const lines = [
    '#!/bin/sh',
    '# Written by ProxFlow: reports setup progress, then removes itself (it may contain a password).',
    'S=/var/lib/proxflow/status',
    'mkdir -p /var/lib/proxflow',
    // instance= tells ProxFlow the status is this deployment's, not one left in a box built from an earlier lab.
    `I=${shq(o.instanceId)}`,
    `stage() { printf 'stage=%s\\ndetail=%s\\ninstance=%s\\n' "$1" "$2" "$I" > "$S.tmp" && mv "$S.tmp" "$S"; }`,
    'finish() { rm -f "$0"; exit 0; }',
    "stage configuring 'cloud-init applied hostname, user and network'",
    '# RHEL-family agents block file reads by default; ProxFlow reads the status file through the agent.',
    'if [ -f /etc/sysconfig/qemu-ga ]; then sed -i -e "s/^FILTER_RPC_ARGS=/#&/" -e "s/^BLACKLIST_RPC=/#&/" /etc/sysconfig/qemu-ga; fi',
    '# ...and SELinux keeps the agent away from files under /var/lib unless this boolean is on.',
    'if command -v setsebool >/dev/null 2>&1 && [ "$(getenforce 2>/dev/null)" != Disabled ]; then setsebool -P virt_qemu_ga_read_nonsecurity_files 1 >/dev/null 2>&1 || true; fi',
    'if command -v qemu-ga >/dev/null 2>&1 || [ -x /usr/bin/qemu-ga ] || [ -x /usr/sbin/qemu-ga ]; then',
    '  systemctl enable qemu-guest-agent >/dev/null 2>&1 || true',
    '  systemctl restart qemu-guest-agent >/dev/null 2>&1 || true',
    'fi',
  ];
  if (o.join) {
    lines.push(
      `DOMAIN=${shq(o.join.domain)}`,
      `JOIN_PW=${shq(o.join.password)}`,
      'if ! command -v realm >/dev/null 2>&1; then',
      '  stage warning "realmd is not installed in this image, so it was not joined to $DOMAIN"',
      '  finish',
      'fi',
      'stage waiting-for-domain "Waiting for $DOMAIN to come online"',
      'n=0',
      'until realm discover "$DOMAIN" >/dev/null 2>&1; do',
      '  n=$((n+1)); if [ "$n" -gt 540 ]; then stage warning "Gave up waiting for $DOMAIN after 3 hours"; finish; fi',
      '  sleep 20',
      'done',
      'stage joining "Joining $DOMAIN"',
      'n=0',
      'until printf \'%s\\n\' "$JOIN_PW" | realm join --user=Administrator "$DOMAIN" >>/var/lib/proxflow/join.log 2>&1; do',
      '  n=$((n+1)); if [ "$n" -gt 10 ]; then stage warning "realm join failed: $(tail -n 2 /var/lib/proxflow/join.log | tr \'\\n\' \' \')"; finish; fi',
      '  sleep 30',
      'done',
      'command -v pam-auth-update >/dev/null 2>&1 && pam-auth-update --enable mkhomedir >/dev/null 2>&1',
      'command -v authselect >/dev/null 2>&1 && authselect enable-feature with-mkhomedir >/dev/null 2>&1',
      'systemctl enable --now oddjobd >/dev/null 2>&1 || true',
      'stage ready "Joined $DOMAIN"',
    );
  } else {
    lines.push("stage ready 'Ready'");
  }
  lines.push('finish');
  return lines.join('\n') + '\n';
}

export function linuxSeedFiles(o: LinuxSeedOptions): Record<'meta-data' | 'user-data' | 'network-config', string> {
  const user: Record<string, unknown> = {
    name: o.username,
    shell: '/bin/bash',
    sudo: 'ALL=(ALL) NOPASSWD:ALL',
    lock_passwd: !o.password,
  };
  if (o.password) user.plain_text_passwd = o.password;
  if (o.sshKeys.length) user.ssh_authorized_keys = o.sshKeys;

  const cfg: Record<string, unknown> = {
    hostname: o.hostname,
    ...(o.fqdn ? { fqdn: o.fqdn } : {}),
    manage_etc_hosts: true,
    users: [user],
    ssh_pwauth: Boolean(o.password),
    // Offline-safe: don't touch package repos unless the user asked for packages.
    package_update: o.packages.length > 0,
    package_upgrade: false,
    ...(o.packages.length ? { packages: o.packages } : {}),
    write_files: [{ path: '/usr/local/sbin/proxflow-finish', permissions: '0700', owner: 'root:root', content: finishScript(o) }],
    runcmd: [['/usr/local/sbin/proxflow-finish']],
  };

  const eth: Record<string, unknown> = { match: { macaddress: o.mac.toLowerCase() } };
  if (o.net.static && o.net.cidr) {
    eth.addresses = [o.net.cidr];
    if (o.net.gateway) eth.routes = [{ to: '0.0.0.0/0', via: o.net.gateway }];
  } else {
    eth.dhcp4 = true;
    if (o.net.overrideDhcpDns) eth['dhcp4-overrides'] = { 'use-dns': false };
  }
  if (o.net.dns.length || o.net.search) eth.nameservers = { addresses: o.net.dns, ...(o.net.search ? { search: [o.net.search] } : {}) };

  return {
    'meta-data': `instance-id: ${o.instanceId}\nlocal-hostname: ${o.hostname}\n`,
    // JSON is valid YAML, which sidesteps YAML quoting pitfalls with passwords and keys.
    'user-data': `#cloud-config\n${JSON.stringify(cfg, null, 2)}\n`,
    'network-config': `${JSON.stringify({ version: 2, ethernets: { primary: eth } }, null, 2)}\n`,
  };
}

export function linuxSeedIso(o: LinuxSeedOptions): Buffer {
  const files = linuxSeedFiles(o);
  return buildIso(
    [
      { name: 'meta-data', data: files['meta-data'] },
      { name: 'user-data', data: files['user-data'] },
      { name: 'network-config', data: files['network-config'] },
      { name: 'proxflow.json', data: JSON.stringify(o.meta, null, 2) },
    ],
    { volumeId: 'CIDATA', jolietVolumeId: 'cidata' },
  );
}
