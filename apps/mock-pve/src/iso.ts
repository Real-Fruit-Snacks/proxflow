/**
 * Independent ISO 9660 reader (deliberately NOT sharing code with the server's writer) so the mock
 * genuinely validates the setup ISOs ProxFlow uploads. Flat root directories only — that's all ProxFlow makes.
 */
const SECTOR = 2048;

export type IsoContents = {
  /** Names as Linux/Windows see them (Joliet when present). */
  joliet: Map<string, Buffer>;
  /** Primary-volume 8.3 names without ";1" — what ESXi's ks=cdrom: reads. */
  primary: Map<string, Buffer>;
  label: string;
};

function readDir(img: Buffer, lba: number, size: number, decode: (id: Buffer) => string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const start = lba * SECTOR;
  let off = 0;
  while (off < size) {
    const len = img[start + off];
    if (!len) {
      off = (Math.floor(off / SECTOR) + 1) * SECTOR; // records never straddle sectors; zero = padding
      continue;
    }
    const rec = img.subarray(start + off, start + off + len);
    const extent = rec.readUInt32LE(2);
    const dataLen = rec.readUInt32LE(10);
    const flags = rec[25]!;
    const id = rec.subarray(33, 33 + rec[32]!);
    off += len;
    if (id.length === 1 && (id[0] === 0 || id[0] === 1)) continue; // "." and ".."
    if (flags & 2) continue; // subdirectories aren't used by ProxFlow
    out.set(decode(id).replace(/;1$/, '').replace(/\.$/, ''), Buffer.from(img.subarray(extent * SECTOR, extent * SECTOR + dataLen)));
  }
  return out;
}

export function readIso(img: Buffer): IsoContents {
  if (img.length < 17 * SECTOR) throw new Error('too small to be an ISO image');
  let primary: Map<string, Buffer> | undefined;
  let joliet: Map<string, Buffer> | undefined;
  let label = '';
  for (let s = 16; s < 64 && (s + 1) * SECTOR <= img.length; s++) {
    const vd = img.subarray(s * SECTOR, (s + 1) * SECTOR);
    if (vd.toString('ascii', 1, 6) !== 'CD001') throw new Error(`missing CD001 signature in sector ${s}`);
    const type = vd[0];
    if (type === 255) break;
    const root = vd.subarray(156, 190);
    const lba = root.readUInt32LE(2);
    const size = root.readUInt32LE(10);
    if (type === 1) {
      primary = readDir(img, lba, size, (id) => id.toString('ascii'));
      label ||= vd.toString('ascii', 40, 72).trim();
    } else if (type === 2 && vd[88] === 0x25 && vd[89] === 0x2f && [0x40, 0x43, 0x45].includes(vd[90]!)) {
      joliet = readDir(img, lba, size, (id) => {
        let s2 = '';
        for (let i = 0; i + 1 < id.length; i += 2) s2 += String.fromCharCode(id.readUInt16BE(i));
        return s2;
      });
      const raw = vd.subarray(40, 72);
      let l = '';
      for (let i = 0; i + 1 < raw.length; i += 2) l += String.fromCharCode(raw.readUInt16BE(i));
      label = l.trim() || label;
    }
  }
  if (!primary) throw new Error('no primary volume descriptor');
  return { primary, joliet: joliet ?? primary, label };
}
