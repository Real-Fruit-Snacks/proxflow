/**
 * Minimal ISO 9660 + Joliet writer for small, flat setup disks (cloud-init seed, Windows answer
 * file, ESXi kickstart). No external tools — works the same on Windows, Linux and offline.
 *
 * Primary volume: 8.3 upper-case names ("KS.CFG;1") — what ESXi's ks=cdrom:/KS.CFG looks for.
 * Joliet volume: full names ("user-data", "autounattend.xml") — what Linux and Windows read.
 */

const SECTOR = 2048;

export type IsoFile = { name: string; data: Uint8Array | string };
export type IsoOptions = { volumeId: string; jolietVolumeId?: string; date?: Date };

const both16 = (b: Buffer, off: number, v: number) => {
  b.writeUInt16LE(v, off);
  b.writeUInt16BE(v, off + 2);
};
const both32 = (b: Buffer, off: number, v: number) => {
  b.writeUInt32LE(v, off);
  b.writeUInt32BE(v, off + 4);
};

function recordDate(d: Date): Buffer {
  return Buffer.from([d.getUTCFullYear() - 1900, d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), 0]);
}

function descriptorDate(d: Date | null): Buffer {
  const b = Buffer.alloc(17);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const s = d
    ? `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}00`
    : '0000000000000000';
  b.write(s, 0, 'ascii');
  return b;
}

const ascii = (s: string, len: number) => {
  const b = Buffer.alloc(len, 0x20);
  b.write(s.slice(0, len), 0, 'ascii');
  return b;
};

const ucs2 = (s: string) => {
  const b = Buffer.alloc(s.length * 2);
  for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), i * 2);
  return b;
};

const jolietField = (s: string, len: number) => {
  const b = Buffer.alloc(len);
  for (let i = 0; i + 1 < len; i += 2) b.writeUInt16BE(0x20, i);
  ucs2(s.slice(0, Math.floor(len / 2))).copy(b, 0);
  return b;
};

/** "user-data" → "USER_DAT.;1", "KS.CFG" → "KS.CFG;1"; unique within the disk. */
function primaryName(name: string, taken: Set<string>): string {
  const upper = name.toUpperCase();
  const dot = upper.lastIndexOf('.');
  const base = ((dot > 0 ? upper.slice(0, dot) : upper).replace(/[^A-Z0-9_]/g, '_').slice(0, 8) || '_');
  const ext = (dot > 0 ? upper.slice(dot + 1) : '').replace(/[^A-Z0-9_]/g, '_').slice(0, 3);
  let id = `${base}.${ext};1`;
  for (let n = 1; taken.has(id); n++) {
    const suffix = `_${n}`;
    id = `${base.slice(0, 8 - suffix.length)}${suffix}.${ext};1`;
  }
  taken.add(id);
  return id;
}

function dirRecord(extent: number, size: number, flags: number, id: Buffer, date: Date): Buffer {
  const len = 33 + id.length + (id.length % 2 === 0 ? 1 : 0);
  const b = Buffer.alloc(len);
  b[0] = len;
  both32(b, 2, extent);
  both32(b, 10, size);
  recordDate(date).copy(b, 18);
  b[25] = flags;
  both16(b, 28, 1);
  b[32] = id.length;
  id.copy(b, 33);
  return b;
}

const recordLen = (id: Buffer) => 33 + id.length + (id.length % 2 === 0 ? 1 : 0);

/** Sectors a directory needs — records may not straddle a sector boundary. */
function dirSectors(ids: Buffer[]): number {
  let sectors = 1;
  let used = 0;
  for (const len of [34, 34, ...ids.map(recordLen)]) {
    if (used + len > SECTOR) {
      sectors++;
      used = 0;
    }
    used += len;
  }
  return sectors;
}

export function buildIso(files: IsoFile[], opts: IsoOptions): Buffer {
  const date = opts.date ?? new Date();
  const seen = new Set<string>();
  const taken = new Set<string>();
  const entries = files.map((f) => {
    if (!f.name || f.name.length > 64 || /[\\/:*?"<>|;\x00-\x1f]/.test(f.name)) throw new Error(`Invalid ISO file name: "${f.name}"`);
    const k = f.name.toLowerCase();
    if (seen.has(k)) throw new Error(`Duplicate ISO file name: "${f.name}"`);
    seen.add(k);
    const data = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : Buffer.from(f.data);
    return { name: f.name, data, pid: Buffer.from(primaryName(f.name, taken), 'ascii'), jid: ucs2(f.name), lba: 0 };
  });

  const pSorted = [...entries].sort((a, b) => Buffer.compare(a.pid, b.pid));
  const jSorted = [...entries].sort((a, b) => Buffer.compare(a.jid, b.jid));
  const pDirSecs = dirSectors(pSorted.map((e) => e.pid));
  const jDirSecs = dirSectors(jSorted.map((e) => e.jid));

  // Layout: 0-15 system area · 16 PVD · 17 Joliet SVD · 18 terminator · 19-22 path tables · dirs · files
  const pvdLba = 16;
  const svdLba = 17;
  const termLba = 18;
  const [pPathL, pPathM, jPathL, jPathM] = [19, 20, 21, 22];
  const pRoot = 23;
  const jRoot = pRoot + pDirSecs;
  let lba = jRoot + jDirSecs;
  for (const e of entries) {
    e.lba = lba;
    lba += Math.max(1, Math.ceil(e.data.length / SECTOR));
  }
  const total = lba;
  const img = Buffer.alloc(total * SECTOR);

  const writeDir = (start: number, sectors: number, sorted: typeof entries, idOf: (e: (typeof entries)[number]) => Buffer) => {
    let sector = start;
    let off = 0;
    const put = (rec: Buffer) => {
      if (off + rec.length > SECTOR) {
        sector++;
        off = 0;
      }
      rec.copy(img, sector * SECTOR + off);
      off += rec.length;
    };
    const size = sectors * SECTOR;
    put(dirRecord(start, size, 2, Buffer.from([0]), date)); // "."
    put(dirRecord(start, size, 2, Buffer.from([1]), date)); // ".." (root's parent is itself)
    for (const e of sorted) put(dirRecord(e.lba, e.data.length, 0, idOf(e), date));
  };
  writeDir(pRoot, pDirSecs, pSorted, (e) => e.pid);
  writeDir(jRoot, jDirSecs, jSorted, (e) => e.jid);

  const pathTable = (rootLba: number, bigEndian: boolean) => {
    const b = Buffer.alloc(10);
    b[0] = 1; // identifier length (root = 0x00)
    if (bigEndian) {
      b.writeUInt32BE(rootLba, 2);
      b.writeUInt16BE(1, 6);
    } else {
      b.writeUInt32LE(rootLba, 2);
      b.writeUInt16LE(1, 6);
    }
    return b;
  };
  pathTable(pRoot, false).copy(img, pPathL * SECTOR);
  pathTable(pRoot, true).copy(img, pPathM * SECTOR);
  pathTable(jRoot, false).copy(img, jPathL * SECTOR);
  pathTable(jRoot, true).copy(img, jPathM * SECTOR);

  const descriptor = (joliet: boolean) => {
    const b = Buffer.alloc(SECTOR);
    const str = joliet ? jolietField : ascii;
    b[0] = joliet ? 2 : 1;
    b.write('CD001', 1, 'ascii');
    b[6] = 1;
    str('', 32).copy(b, 8);
    const vol = joliet ? (opts.jolietVolumeId ?? opts.volumeId) : opts.volumeId.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    str(vol, 32).copy(b, 40);
    both32(b, 80, total);
    if (joliet) b.write('%/E', 88, 'ascii'); // Joliet UCS-2 level 3
    both16(b, 120, 1);
    both16(b, 124, 1);
    both16(b, 128, SECTOR);
    both32(b, 132, 10);
    b.writeUInt32LE(joliet ? jPathL : pPathL, 140);
    b.writeUInt32BE(joliet ? jPathM : pPathM, 148);
    const root = joliet ? jRoot : pRoot;
    dirRecord(root, (joliet ? jDirSecs : pDirSecs) * SECTOR, 2, Buffer.from([0]), date).copy(b, 156);
    str('', 128).copy(b, 190);
    str('', 128).copy(b, 318);
    str('PROXFLOW', 128).copy(b, 446);
    str('PROXFLOW', 128).copy(b, 574);
    str('', 37).copy(b, 702);
    str('', 37).copy(b, 739);
    str('', 37).copy(b, 776);
    descriptorDate(date).copy(b, 813);
    descriptorDate(date).copy(b, 830);
    descriptorDate(null).copy(b, 847);
    descriptorDate(date).copy(b, 864);
    b[881] = 1;
    return b;
  };
  descriptor(false).copy(img, pvdLba * SECTOR);
  descriptor(true).copy(img, svdLba * SECTOR);
  const term = Buffer.alloc(SECTOR);
  term[0] = 255;
  term.write('CD001', 1, 'ascii');
  term[6] = 1;
  term.copy(img, termLba * SECTOR);

  for (const e of entries) e.data.copy(img, e.lba * SECTOR);
  return img;
}
