export function fmtBytes(b: number): string {
  if (!b || b <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function fmtGiB(g?: number): string {
  if (g === undefined) return '—';
  return g >= 1024 ? `${(g / 1024).toFixed(1)} TiB` : g < 1 ? `${Math.round(g * 1024)} MiB` : `${Math.round(g)} GiB`;
}

export function fmtUptime(s: number): string {
  if (!s || s <= 0) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export const pct = (v: number) => `${Math.round((v || 0) * 100)}%`;

export function timeAgo(iso: string | undefined, now: number): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 2) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}
