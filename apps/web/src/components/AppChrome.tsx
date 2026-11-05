/** Header pieces shared by the Map and Build screens. */
import clsx from 'clsx';
import { Hammer, Map as MapIcon, Plug } from 'lucide-react';
import type { Connection } from '@proxflow/shared';

export type Mode = 'map' | 'build';

/** Props every screen receives from the shell. */
export type CommonProps = {
  mode: Mode;
  onMode: (m: Mode) => void;
  connections: Connection[];
  connectionsLoaded: boolean;
  onOpenConnections: () => void;
};

export function Brand() {
  return (
    <div className="flex shrink-0 items-center gap-2">
      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-gradient-to-br from-sky-400 to-violet-500 text-[11px] font-black text-zinc-950">PF</div>
      <span className="hidden font-semibold tracking-tight text-zinc-100 sm:inline">ProxFlow</span>
    </div>
  );
}

export function ModeSwitch({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  const item = (m: Mode, Icon: typeof MapIcon, label: string) => (
    <button
      type="button"
      onClick={() => onMode(m)}
      className={clsx(
        'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
        mode === m ? 'bg-zinc-800 text-zinc-100 shadow' : 'text-zinc-500 hover:text-zinc-300',
      )}
      aria-pressed={mode === m}
    >
      <Icon className="h-3.5 w-3.5" />
      <span className="hidden md:inline">{label}</span>
    </button>
  );
  return (
    <div className="flex shrink-0 gap-0.5 rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5">
      {item('map', MapIcon, 'Map')}
      {item('build', Hammer, 'Build')}
    </div>
  );
}

export function ConnectionButton({ connections, onOpen, title }: { connections: Connection[]; onOpen: () => void; title?: string }) {
  const total = connections.length;
  if (total === 0) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-sky-500/50 bg-sky-500/15 px-3 text-xs font-semibold text-sky-100 transition-colors hover:bg-sky-500/25"
      >
        <Plug className="h-3.5 w-3.5" /> Connect to Proxmox
      </button>
    );
  }
  const okCount = connections.filter((c) => c.status?.ok).length;
  const single = total === 1 ? connections[0] : undefined;
  const dot = okCount === total ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.9)]' : okCount > 0 ? 'bg-amber-400' : 'bg-rose-400';
  const text = single
    ? single.status
      ? single.status.ok
        ? `${single.status.mock ? 'Mock ' : ''}PVE ${single.status.version ?? ''}`.trim()
        : `${single.name}: unreachable`
      : single.name
    : `${okCount}/${total} hosts connected`;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={title ?? 'Manage connections'}
      className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border border-zinc-800 px-2.5 text-xs text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-800"
    >
      <span className={clsx('h-2 w-2 shrink-0 rounded-full', dot)} />
      <span className="hidden md:inline">{text}</span>
      <Plug className="h-3.5 w-3.5 text-zinc-500 md:hidden" />
    </button>
  );
}
