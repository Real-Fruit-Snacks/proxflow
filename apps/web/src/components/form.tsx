/** Small dark-themed form controls for the lab builder panels. */
import clsx from 'clsx';
import type { ReactNode } from 'react';

const INPUT =
  'h-8 w-full min-w-0 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500/60 focus:outline-none disabled:opacity-50';

export function Field({ label, hint, error, children, className }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={clsx('block min-w-0', className)}>
      <span className="mb-1 flex items-baseline gap-2">
        <span className="shrink-0 text-[11px] font-medium text-zinc-400">{label}</span>
        {error ? <span className="truncate text-[10px] text-rose-300">{error}</span> : hint ? <span className="truncate text-[10px] text-zinc-600">{hint}</span> : null}
      </span>
      {children}
    </label>
  );
}

export function TextInput({ value, onChange, placeholder, mono, type = 'text', invalid }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean; type?: string; invalid?: boolean }) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete={type === 'password' ? 'new-password' : 'off'}
      className={clsx(INPUT, mono && 'font-mono', invalid && 'border-rose-500/60')}
    />
  );
}

export function TextArea({ value, onChange, placeholder, rows = 3 }: { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      rows={rows}
      spellCheck={false}
      className="w-full min-w-0 resize-y rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 font-mono text-[11px] text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500/60 focus:outline-none"
    />
  );
}

export function NumberInput({ value, onChange, min, max, step = 1, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string }) {
  return (
    <div className="relative">
      <input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        className={clsx(INPUT, 'tabular-nums', suffix && 'pr-9')}
      />
      {suffix && <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500">{suffix}</span>}
    </div>
  );
}

export type Option<T extends string> = { value: T; label: string; disabled?: boolean; group?: string };

export function Select<T extends string>({ value, onChange, options, placeholder }: { value: T | ''; onChange: (v: T) => void; options: Option<T>[]; placeholder?: string }) {
  const groups = [...new Set(options.map((o) => o.group ?? ''))];
  const render = (o: Option<T>) => (
    <option key={o.value} value={o.value} disabled={o.disabled}>
      {o.label}
    </option>
  );
  // An option may itself have the empty value (e.g. "Lab default"); then there's no placeholder to show.
  const known = options.some((o) => o.value === value);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} className={clsx(INPUT, 'pr-6', !value && !known && 'text-zinc-500')}>
      {!known && <option value={value}>{value && !known ? `${value} (not found)` : (placeholder ?? 'Choose…')}</option>}
      {groups.length > 1
        ? groups.map((g) => (
            <optgroup key={g} label={g}>
              {options.filter((o) => (o.group ?? '') === g).map(render)}
            </optgroup>
          ))
        : options.map(render)}
    </select>
  );
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div className="flex gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clsx('flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors', value === o.value ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Checkbox({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-300">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-sky-500" />
      <span>
        {label}
        {hint && <span className="block text-[10px] text-zinc-500">{hint}</span>}
      </span>
    </label>
  );
}

export function PanelSection({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
