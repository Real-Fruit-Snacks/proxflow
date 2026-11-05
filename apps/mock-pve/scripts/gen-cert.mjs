// Generates a self-signed certificate for the mock's HTTPS listener (mirrors a fresh Proxmox install:
// a cert for the node's hostname that no trust store knows about).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const certDir = resolve(dirname(fileURLToPath(import.meta.url)), '../certs');
mkdirSync(certDir, { recursive: true });
const cert = resolve(certDir, 'cert.pem');
const key = resolve(certDir, 'key.pem');

if (existsSync(cert) && existsSync(key) && !process.argv.includes('--force')) {
  console.log(`certs already exist in ${certDir} (use --force to regenerate)`);
  process.exit(0);
}

const r = spawnSync(
  'openssl',
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825', '-keyout', key, '-out', cert, '-subj', '/CN=pve-mock', '-addext', 'subjectAltName=DNS:pve-mock,DNS:localhost'],
  { stdio: 'inherit' },
);
if (r.status !== 0) {
  console.error('openssl failed — is it installed? (Git for Windows ships one at C:\\Program Files\\Git\\usr\\bin\\openssl.exe)');
  process.exit(1);
}
console.log(`wrote ${cert} and ${key}`);
