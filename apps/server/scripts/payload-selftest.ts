// Generates every setup payload with hostile inputs so they can be checked by real parsers.
// Usage: tsx scripts/payload-selftest.ts <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCidr } from '@proxflow/shared';
import { ESXI_BOOT_APPEND, esxiKickstart, esxiKickstartIso, keysFor } from '../src/build/payloads/esxi.js';
import { linuxSeedFiles, linuxSeedIso } from '../src/build/payloads/linux.js';
import { autounattendXml, toWindowsMac, windowsAnswerIso, windowsSetupScript, type WindowsSetupConfig } from '../src/build/payloads/windows.js';

const out = process.argv[2];
if (!out) throw new Error('usage: payload-selftest <outDir>');
mkdirSync(out, { recursive: true });

export const NASTY = `P@ss'w"o<r>d&$x\`y;z`;

const setup: WindowsSetupConfig = {
  computerName: 'DC01',
  adminPassword: NASTY,
  mac: toWindowsMac('bc:24:11:aa:bb:cc'),
  net: { static: true, ip: '10.0.0.10', prefix: 24, gateway: '10.0.0.1', dns: ['10.0.0.1'] },
  role: 'dc',
  installDrivers: true,
  identity: false,
  domain: 'lab.internal',
  netbios: 'LAB',
  dsrmPassword: NASTY,
  forwarders: [],
};
const answer = { setup, version: '2022' as const, edition: 'standard-desktop' as const, virtio: true };
writeFileSync(join(out, 'autounattend.xml'), autounattendXml(answer));
writeFileSync(join(out, 'autounattend-novirtio.xml'), autounattendXml({ ...answer, virtio: false, productKey: 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE' }));
writeFileSync(join(out, 'setup.ps1'), windowsSetupScript(setup));
writeFileSync(join(out, 'answer.iso'), windowsAnswerIso(answer, { kind: 'windows', role: 'dc' }));
writeFileSync(join(out, 'expected-password.txt'), NASTY);

const seed = {
  instanceId: 'pf-test-101',
  hostname: 'linux01',
  username: 'labadmin',
  password: NASTY,
  sshKeys: ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAItest user@host'],
  mac: 'BC:24:11:00:00:01',
  net: { static: false, dns: ['10.0.0.10'], search: 'lab.internal', overrideDhcpDns: true },
  family: 'debian' as const,
  packages: [],
  join: { domain: 'lab.internal', password: NASTY },
  meta: { kind: 'linux-vm' },
};
const files = linuxSeedFiles(seed);
for (const [k, v] of Object.entries(files)) writeFileSync(join(out, k), v);
const userData = JSON.parse(files['user-data'].replace(/^#cloud-config\n/, ''));
writeFileSync(join(out, 'proxflow-finish.sh'), userData.write_files[0].content);
writeFileSync(join(out, 'seed.iso'), linuxSeedIso(seed));

const esxi = { hostname: 'esxi01', rootPassword: 'Lab-Pass-9!', ip: '10.0.0.20', cidr: parseCidr('10.0.0.20/24')!, gateway: '10.0.0.1', dns: ['10.0.0.10'], vlan: 20 };
writeFileSync(join(out, 'KS.CFG'), esxiKickstart(esxi));
writeFileSync(join(out, 'ks.iso'), esxiKickstartIso(esxi, { kind: 'esxi' }));

console.log(JSON.stringify({ keys: keysFor(ESXI_BOOT_APPEND), packageUpdate: userData.package_update, hasPackages: 'packages' in userData }));
