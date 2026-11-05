/** Small IPv4 helpers shared by validation (UI + server) and the planner. */

export function parseIPv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255)) return null;
  return ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
}

export const formatIPv4 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

export type Cidr = { ip: number; prefix: number; mask: number; network: number; broadcast: number };

export function parseCidr(s: string | undefined): Cidr | null {
  if (!s) return null;
  const [addr, pre] = s.trim().split('/');
  if (!addr || pre === undefined || !/^\d{1,2}$/.test(pre)) return null;
  const ip = parseIPv4(addr);
  const prefix = Number(pre);
  if (ip === null || prefix < 1 || prefix > 32) return null;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ip & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { ip, prefix, mask, network, broadcast };
}

export const prefixToNetmask = (prefix: number) => formatIPv4(prefix <= 0 ? 0 : prefix >= 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0);

export const ipOf = (cidrOrIp: string) => cidrOrIp.split('/')[0]!.trim();

export function inSubnet(ip: string, cidr: Cidr): boolean {
  const n = parseIPv4(ip);
  return n !== null && ((n & cidr.mask) >>> 0) === cidr.network;
}

/** Free addresses in the bridge's subnet, starting at host .start, as "a.b.c.d/prefix". */
export function suggestStaticIps(bridgeCidr: string | undefined, count: number, used: Iterable<string>, start = 200): string[] {
  const c = parseCidr(bridgeCidr);
  if (!c || c.prefix > 30) return [];
  const taken = new Set<number>([c.ip]);
  for (const u of used) {
    const n = parseIPv4(ipOf(u));
    if (n !== null) taken.add(n);
  }
  const first = c.network + 1;
  const last = c.broadcast - 1;
  const out: string[] = [];
  let h = Math.min(Math.max(first, c.network + start), last);
  for (let tries = 0; out.length < count && tries <= last - first; tries++) {
    if (!taken.has(h)) {
      out.push(`${formatIPv4(h)}/${c.prefix}`);
      taken.add(h);
    }
    h = h >= last ? first : h + 1;
  }
  return out;
}

export const versionAtLeast = (version: string | undefined, min: string) => {
  const a = (version ?? '0').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const b = min.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};
