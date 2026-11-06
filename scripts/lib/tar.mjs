// Minimal tar reader/writer. Writing explicit modes means a release built on Windows still marks
// the Linux launcher and node binary as executable. Paths too long for ustar get a pax header.
import { gunzipSync, gzipSync } from 'node:zlib';

const BLOCK = 512;

function octal(buf, off, len, value) {
  buf.write(value.toString(8).padStart(len - 1, '0') + '\0', off, len, 'ascii');
}

/** "a/b/c" → ustar name (≤100) + prefix (≤155), split at a "/"; undefined if it doesn't fit. */
function splitPath(path) {
  if (Buffer.byteLength(path) <= 100) return { name: path, prefix: '' };
  for (let i = path.length - 1; i > 0; i--) {
    if (path[i] !== '/') continue;
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  return undefined;
}

function header(path, { size, mode, mtime, type }) {
  const h = Buffer.alloc(BLOCK);
  const split = splitPath(path);
  const { name, prefix } = split ?? { name: path.slice(-100), prefix: '' }; // the pax header before it has the full path
  h.write(name, 0, 100, 'utf8');
  octal(h, 100, 8, mode);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156); // checksum placeholder: spaces
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

/** A pax "x" record carrying the full path, for paths ustar can't hold. */
function paxPath(path, mtime) {
  const rest = ` path=${path}\n`;
  let len = Buffer.byteLength(rest);
  while (String(len).length + Buffer.byteLength(rest) !== len) len = String(len).length + Buffer.byteLength(rest);
  const body = Buffer.from(`${len}${rest}`);
  const pad = (BLOCK - (body.length % BLOCK)) % BLOCK;
  return [header('PaxHeader', { size: body.length, mode: 0o644, mtime, type: 'x' }), body, Buffer.alloc(pad)];
}

function entryHeader(path, opts) {
  return splitPath(path) ? [header(path, opts)] : [...paxPath(path, opts.mtime), header(path, opts)];
}

/**
 * entries: { path, data?: Buffer, mode?: number, dir?: boolean }[]
 * Parent directories are added automatically.
 */
export function createTarGz(entries, { mtime = Math.floor(Date.now() / 1000), level = 9 } = {}) {
  const parts = [];
  const dirs = new Set();
  const addDir = (p) => {
    const parent = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
    if (parent && !dirs.has(parent)) addDir(parent);
    if (!dirs.has(p)) {
      dirs.add(p);
      parts.push(...entryHeader(`${p}/`, { size: 0, mode: 0o755, mtime, type: '5' }));
    }
  };
  for (const e of entries) {
    const parent = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '';
    if (parent) addDir(parent);
    if (e.dir) {
      addDir(e.path);
      continue;
    }
    const data = Buffer.from(e.data);
    parts.push(...entryHeader(e.path, { size: data.length, mode: e.mode ?? 0o644, mtime, type: '0' }));
    parts.push(data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return gzipSync(Buffer.concat(parts), { level });
}

/** Every entry of a .tar.gz as { name, type, mode, data } (handles pax and GNU long-name headers). */
export function* readTarGz(gz) {
  const tar = gunzipSync(gz);
  let off = 0;
  let longName;
  let pax;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const field = (o, l) => h.toString('utf8', o, o + l).replace(/\0.*$/s, '');
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1) || '0';
    const prefix = h.toString('ascii', 257, 262) === 'ustar' ? field(345, 155) : '';
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const data = tar.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'x' || type === 'g') {
      if (type === 'x') pax = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))?.[1];
      continue;
    }
    const octalField = (o, l) => parseInt(field(o, l).trim() || '0', 8);
    yield { name: pax ?? longName ?? name, type: type === '\0' ? '0' : type, mode: octalField(100, 8), mtime: octalField(136, 12), data };
    pax = undefined;
    longName = undefined;
  }
}

/** Extracts the named files from a .tar.gz. */
export function extractFromTarGz(gz, wanted) {
  const out = new Map();
  for (const e of readTarGz(gz)) if (e.type === '0' && wanted.includes(e.name)) out.set(e.name, Buffer.from(e.data));
  return out;
}
