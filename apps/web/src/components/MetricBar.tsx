import clsx from 'clsx';
import { pct } from '../lib/format';

export function MetricBar({
  label,
  value,
  hint,
  className,
}: {
  label?: string;
  value: number;
  hint?: string;
  className?: string;
}) {
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const color = v > 0.85 ? 'bg-rose-400' : v > 0.6 ? 'bg-amber-400' : 'bg-sky-400';
  return (
    <div className={clsx('text-[10px] leading-none', className)}>
      {(label || hint) && (
        <div className="mb-1 flex justify-between text-zinc-400">
          <span>{label}</span>
          <span className="tabular-nums">{hint ?? pct(v)}</span>
        </div>
      )}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
        <div className={clsx('h-full rounded-full transition-[width] duration-700 ease-out', color)} style={{ width: `${v * 100}%` }} />
      </div>
    </div>
  );
}
