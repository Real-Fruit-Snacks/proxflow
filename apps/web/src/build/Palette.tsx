import clsx from 'clsx';
import { ChevronsLeft, ChevronsRight, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { TargetInventory } from '@proxflow/shared';
import { PRESETS, type PaletteKind, type Preset } from './design';
import { KIND_STYLES } from './labels';

export const DRAG_TYPE = 'application/x-proxflow-kind';

const FOCUS = 'focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/60';

const ITEMS: { kind: PaletteKind; hint: (inv?: TargetInventory) => string }[] = [
  { kind: 'windows-dc', hint: () => 'New AD forest, from the Windows ISO' },
  { kind: 'windows-server', hint: () => 'Member or standalone server' },
  {
    kind: 'linux-vm',
    hint: (inv) => {
      // Restored boxes (pf-box templates) are the same boxes as their backups — don't count them twice.
      const n =
        (inv?.backups.filter((b) => b.subtype === 'qemu').length ?? 0) +
        (inv?.vmTemplates.filter((t) => t.type === 'qemu' && !t.box).length ?? 0) +
        (inv?.diskImages.length ?? 0);
      return inv ? `${n} box${n === 1 ? '' : 'es'} / templates on storage` : 'From a box or template';
    },
  },
  { kind: 'lxc', hint: (inv) => (inv ? `${inv.lxcTemplates.length} container templates` : 'Lightweight container') },
  { kind: 'esxi', hint: () => 'Nested, from the ESXi ISO (experimental)' },
];

type Props = {
  inv?: TargetInventory;
  onAdd: (kind: PaletteKind) => void;
  onPreset: (p: Preset) => void;
  disabled?: boolean;
  compact: boolean;
  onToggleCompact: () => void;
};

const dragProps = (kind: PaletteKind, disabled?: boolean) => ({
  draggable: !disabled,
  onDragStart: (e: React.DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, kind);
    e.dataTransfer.effectAllowed = 'copy';
  },
});

function PresetList({ onPreset, disabled }: { onPreset: (p: Preset) => void; disabled?: boolean }) {
  return (
    <div className="space-y-1">
      {PRESETS.map((p) => (
        <button
          key={p.id}
          type="button"
          disabled={disabled}
          onClick={() => onPreset(p)}
          className={clsx('block w-full rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-zinc-800/70 disabled:opacity-40', FOCUS)}
        >
          <span className="block text-xs text-zinc-200">{p.label}</span>
          <span className="block text-[10px] leading-snug text-zinc-500">{p.description}</span>
        </button>
      ))}
    </div>
  );
}

export function Palette({ inv, onAdd, onPreset, disabled, compact, onToggleCompact }: Props) {
  const [presetsOpen, setPresetsOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!presetsOpen) return;
    const close = (e: MouseEvent) => !popRef.current?.contains(e.target as Node) && setPresetsOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [presetsOpen]);

  if (compact) {
    return (
      <aside className="relative flex w-14 shrink-0 flex-col items-center gap-1.5 border-r border-zinc-800 bg-zinc-950/80 py-3">
        {ITEMS.map(({ kind, hint }) => {
          const s = KIND_STYLES[kind];
          const Icon = s.icon;
          return (
            <button
              key={kind}
              type="button"
              disabled={disabled}
              {...dragProps(kind, disabled)}
              onClick={() => onAdd(kind)}
              title={`${s.label} — ${hint(inv)}\nDrag onto the canvas, or click to add`}
              className={clsx('flex h-10 w-10 cursor-grab items-center justify-center rounded-lg transition-colors hover:bg-zinc-800 active:cursor-grabbing disabled:opacity-40', s.tint, FOCUS)}
            >
              <Icon className="h-4.5 w-4.5" />
            </button>
          );
        })}
        <div className="my-1 h-px w-8 bg-zinc-800" />
        <div ref={popRef} className="relative">
          <button
            type="button"
            title="Presets"
            disabled={disabled}
            onClick={() => setPresetsOpen((o) => !o)}
            className={clsx('flex h-10 w-10 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40', presetsOpen && 'bg-zinc-800 text-zinc-100', FOCUS)}
          >
            <Sparkles className="h-4.5 w-4.5" />
          </button>
          {presetsOpen && (
            <div className="absolute left-12 top-0 z-30 w-60 rounded-xl border border-zinc-800 bg-zinc-950 p-2 shadow-2xl shadow-black/60">
              <h3 className="mb-1 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Presets</h3>
              <PresetList
                disabled={disabled}
                onPreset={(p) => {
                  setPresetsOpen(false);
                  onPreset(p);
                }}
              />
            </div>
          )}
        </div>
        <button type="button" onClick={onToggleCompact} title="Show labels" className={clsx('mt-auto flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200', FOCUS)}>
          <ChevronsRight className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  return (
    <aside className="scroll-thin flex w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-zinc-800 bg-zinc-950/80 p-3">
      <div>
        <div className="mb-2 flex items-center px-1">
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Add machines</h3>
          <button type="button" onClick={onToggleCompact} title="Collapse to icons" className={clsx('ml-auto rounded p-0.5 text-zinc-600 hover:text-zinc-200', FOCUS)}>
            <ChevronsLeft className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="space-y-1.5">
          {ITEMS.map(({ kind, hint }) => {
            const s = KIND_STYLES[kind];
            const Icon = s.icon;
            return (
              <button
                key={kind}
                type="button"
                disabled={disabled}
                {...dragProps(kind, disabled)}
                onClick={() => onAdd(kind)}
                title="Drag onto the canvas, or click to add"
                className={clsx(
                  'flex w-full cursor-grab items-center gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/70 px-2.5 py-2 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-800/80 active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40',
                  FOCUS,
                )}
              >
                <div className={clsx('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', s.tint)}>
                  <Icon className="h-4 w-4" />
                </div>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-zinc-100">{s.label}</span>
                  <span className="block truncate text-[10px] text-zinc-500">{hint(inv)}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-1.5 px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          <Sparkles className="h-3 w-3" /> Presets
        </h3>
        <PresetList onPreset={onPreset} disabled={disabled} />
      </div>
    </aside>
  );
}
