import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useState, type ButtonHTMLAttributes } from 'react';
import type { Tone } from './Badge';

const TONES: Record<Tone, string> = {
  zinc: 'border-zinc-700 bg-zinc-800/70 text-zinc-200 hover:bg-zinc-700/80',
  emerald: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25',
  sky: 'border-sky-500/40 bg-sky-500/15 text-sky-200 hover:bg-sky-500/25',
  amber: 'border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25',
  rose: 'border-rose-500/40 bg-rose-500/15 text-rose-200 hover:bg-rose-500/25',
  violet: 'border-violet-500/40 bg-violet-500/15 text-violet-200 hover:bg-violet-500/25',
};

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: LucideIcon;
  tone?: Tone;
  size?: 'sm' | 'md';
};

export function ActionButton({ icon: Icon, tone = 'zinc', size = 'md', className, children, ...rest }: ActionButtonProps) {
  return (
    <button
      type="button"
      {...rest}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        size === 'md' ? 'px-3 py-1.5 text-xs' : 'px-2 py-1 text-[11px]',
        TONES[tone],
        className,
      )}
    >
      {Icon && <Icon className={size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3'} />}
      {children}
    </button>
  );
}

/** Two-step button: first click arms it ("Confirm?"), second click fires. Disarms after 3s. */
export function ConfirmButton({
  onConfirm,
  confirmLabel = 'Confirm?',
  children,
  tone,
  ...rest
}: Omit<ActionButtonProps, 'onClick'> & { onConfirm: () => void; confirmLabel?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <ActionButton
      {...rest}
      tone={armed ? 'rose' : tone}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel : children}
    </ActionButton>
  );
}
