import clsx from 'clsx';
import { Activity, ChevronRight, HardDrive, LayoutGrid, LoaderCircle, Maximize, Network, Search } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { ClusterInfo } from '@proxflow/shared';
import { timeAgo } from '../lib/format';
import { Brand, ConnectionButton, ModeSwitch, type CommonProps } from './AppChrome';
import { Badge } from './Badge';

function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function Toggle({
  active,
  onClick,
  children,
  label,
  activeClass = 'border-zinc-600 bg-zinc-800 text-zinc-100',
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  /** Text label; hidden on narrow viewports (icon stays). */
  label: string;
  activeClass?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title ?? label}
      onClick={onClick}
      className={clsx(
        'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 text-xs font-medium transition-colors',
        active ? activeClass : 'border-zinc-800 bg-transparent text-zinc-500 hover:border-zinc-700 hover:text-zinc-300',
      )}
    >
      {children}
      <span className="hidden xl:inline">{label}</span>
    </button>
  );
}

function IconButton({ onClick, title, children }: { onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-800 text-zinc-400 transition-colors hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100"
    >
      {children}
    </button>
  );
}

export type TopBarProps = {
  common: CommonProps;
  clusters: ClusterInfo[];
  counts: { nodes: number; guests: number; running: number };
  fetchedAt?: string;
  isFetching: boolean;
  search: string;
  onSearch: (v: string) => void;
  live: boolean;
  onLive: (v: boolean) => void;
  showNet: boolean;
  onShowNet: (v: boolean) => void;
  showStorage: boolean;
  onShowStorage: (v: boolean) => void;
  onRelayout: () => void;
  onFit: () => void;
};

export function TopBar(p: TopBarProps) {
  const now = useNow();
  const primary = p.clusters.length === 1 ? p.clusters[0] : undefined;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 overflow-hidden border-b border-zinc-800 bg-zinc-950/95 px-3 md:gap-3 md:px-4">
      <Brand />
      <ModeSwitch mode={p.common.mode} onMode={p.common.onMode} />

      {p.clusters.length > 0 && (
        <div className="flex min-w-0 shrink items-center gap-2 whitespace-nowrap text-sm">
          <ChevronRight className="hidden h-4 w-4 shrink-0 text-zinc-700 sm:block" />
          {primary ? (
            <>
              <span className="truncate font-medium text-zinc-200">{primary.name}</span>
              {primary.ok && <Badge tone={primary.quorate ? 'emerald' : 'rose'}>{primary.quorate ? 'quorate' : 'no quorum'}</Badge>}
            </>
          ) : (
            <span className="truncate font-medium text-zinc-200">{p.clusters.length} clusters</span>
          )}
          <span className="hidden text-xs text-zinc-500 2xl:inline">
            {p.counts.nodes} {p.counts.nodes === 1 ? 'node' : 'nodes'} · {p.counts.running}/{p.counts.guests} guests running
          </span>
        </div>
      )}

      <div className="relative mx-auto min-w-[110px] max-w-80 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
        <input
          value={p.search}
          onChange={(e) => p.onSearch(e.target.value)}
          placeholder="Filter…"
          title="Filter by name, VMID, tag or node"
          spellCheck={false}
          className="h-8 w-full rounded-lg border border-zinc-800 bg-zinc-900 pl-8 pr-3 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500/60 focus:outline-none"
        />
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Toggle
          active={p.showNet}
          onClick={() => p.onShowNet(!p.showNet)}
          label="Network"
          title="Always show NIC → bridge edges (otherwise only for the hovered/selected node)"
          activeClass="border-sky-500/40 bg-sky-500/10 text-sky-200"
        >
          <Network className="h-3.5 w-3.5" />
        </Toggle>
        <Toggle
          active={p.showStorage}
          onClick={() => p.onShowStorage(!p.showStorage)}
          label="Storage"
          title="Always show disk → storage edges (otherwise only for the hovered/selected node)"
          activeClass="border-amber-500/40 bg-amber-500/10 text-amber-200"
        >
          <HardDrive className="h-3.5 w-3.5" />
        </Toggle>
        <div className="mx-1 h-5 w-px bg-zinc-800" />
        <Toggle active={p.live} onClick={() => p.onLive(!p.live)} label="Live" title="Auto-refresh every 4s" activeClass="border-emerald-500/40 bg-emerald-500/10 text-emerald-200">
          {p.isFetching ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
        </Toggle>
        <IconButton onClick={p.onRelayout} title="Re-layout (resets dragged positions)">
          <LayoutGrid className="h-4 w-4" />
        </IconButton>
        <IconButton onClick={p.onFit} title="Fit to view">
          <Maximize className="h-4 w-4" />
        </IconButton>
        <div className="mx-1 h-5 w-px bg-zinc-800" />
        <ConnectionButton connections={p.common.connections} onOpen={p.common.onOpenConnections} title={`Manage connections\nupdated ${timeAgo(p.fetchedAt, now)}`} />
      </div>
    </header>
  );
}
