// Generates a self-signed certificate for the mock's HTTPS listener (mirrors a fresh Proxmox install:
// a cert for the node's hostname that no trust store knows about). Plain Node.js, no openssl needed.
import { X509Certificate, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const certDir = resolve(dirname(fileURLToPath(import.meta.url)), '../certs');
const certFile = resolve(certDir, 'cert.pem');
const keyFile = resolve(certDir, 'key.pem');

if (existsSync(certFile) && existsSync(keyFile) && !process.argv.includes('--force')) {
  console.log(`certs already exist in ${certDir} (use --force to regenerate)`);
  process.exit(0);
}

// ── minimal DER encoder, just enough for one X.509 v3 certificate ──
const length = (n) => {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (; n > 0; n >>= 8) bytes.unshift(n & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
};
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p) : p)));
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const oid = (dotted) => {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (let v of rest) {
    const chunk = [v & 0x7f];
    for (v >>= 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
};
const integer = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const utcTime = (d) => tlv(0x17, `${d.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`); // YYMMDDHHMMSSZ
const name = (cn) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, cn))));
const sha256WithRsa = seq(oid('1.2.840.113549.1.1.11'), Buffer.from([0x05, 0x00]));

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const serial = randomBytes(16);
serial[0] &= 0x7f; // positive
const now = new Date();
const notBefore = new Date(now.getTime() - 60_000);
const notAfter = new Date(now.getTime() + 825 * 86_400_000);
const subjectAltName = seq(oid('2.5.29.17'), tlv(0x04, seq(tlv(0x82, 'pve-mock'), tlv(0x82, 'localhost'))));

const tbs = seq(
  tlv(0xa0, integer(Buffer.from([2]))), // v3
  integer(serial),
  sha256WithRsa,
  name('pve-mock'),
  seq(utcTime(notBefore), utcTime(notAfter)),
  name('pve-mock'),
  publicKey.export({ type: 'spki', format: 'der' }),
  tlv(0xa3, seq(subjectAltName)),
);
const der = seq(tbs, sha256WithRsa, tlv(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)));
const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;

// Parse it back before writing anything: a malformed certificate would only show up later as a TLS error.
const x509 = new X509Certificate(pem);
if (!x509.verify(createPublicKey(privateKey)) || !x509.checkHost('localhost')) throw new Error('generated certificate did not verify');

mkdirSync(certDir, { recursive: true });
writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
writeFileSync(certFile, pem);
console.log(`wrote ${certFile} and ${keyFile}`);
