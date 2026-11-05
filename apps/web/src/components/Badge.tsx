import clsx from 'clsx';
import type { ReactNode } from 'react';

export type Tone = 'zinc' | 'emerald' | 'sky' | 'amber' | 'rose' | 'violet';

const TONES: Record<Tone, string> = {
  zinc: 'border-zinc-700 bg-zinc-800/80 text-zinc-300',
  emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  sky: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
  amber: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  rose: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  violet: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
};

export function Badge({ children, tone = 'zinc', className }: { children: ReactNode; tone?: Tone; className?: string }) {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center rounded border px-1.5 py-px text-[10px] font-semibold uppercase leading-4 tracking-wide',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
