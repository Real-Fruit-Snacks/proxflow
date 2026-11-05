// Writes a test ISO with the same shape as ProxFlow's setup disks.
// Usage: tsx scripts/iso-selftest.ts <out.iso>
import { writeFileSync } from 'node:fs';
import { buildIso } from '../src/iso/iso9660.js';

const out = process.argv[2];
if (!out) throw new Error('usage: iso-selftest <out.iso>');
const big = 'x'.repeat(5000) + '\nEND\n'; // spans 3 sectors
const iso = buildIso(
  [
    { name: 'user-data', data: '#cloud-config\nhostname: test\n' },
    { name: 'meta-data', data: 'instance-id: t1\n' },
    { name: 'network-config', data: 'version: 2\n' },
    { name: 'KS.CFG', data: 'vmaccepteula\n' },
    { name: 'autounattend.xml', data: '<?xml version="1.0"?><unattend/>' },
    { name: 'big-file.txt', data: big },
  ],
  { volumeId: 'CIDATA', jolietVolumeId: 'cidata' },
);
writeFileSync(out, iso);
console.log(`wrote ${out} (${iso.length} bytes)`);
