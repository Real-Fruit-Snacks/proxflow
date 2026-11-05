import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Toaster } from 'sonner';
import { useConnections } from './api';
import { BuildView } from './build/BuildView';
import { Canvas, type FocusRequest } from './Canvas';
import type { CommonProps, Mode } from './components/AppChrome';
import { ConnectionsDialog } from './components/ConnectionsDialog';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, staleTime: 1000, retry: 1 },
  },
});

const MODE_KEY = 'proxflow.mode';

function Shell() {
  const [mode, setMode] = useState<Mode>(() => (localStorage.getItem(MODE_KEY) === 'build' ? 'build' : 'map'));
  const [connDialog, setConnDialog] = useState(false);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const conns = useConnections();

  useEffect(() => localStorage.setItem(MODE_KEY, mode), [mode]);

  // First run: nothing saved yet → open the connect dialog once.
  const autoOpened = useRef(false);
  useEffect(() => {
    if (conns.data && conns.data.length === 0 && !autoOpened.current) {
      autoOpened.current = true;
      setConnDialog(true);
    }
  }, [conns.data]);

  const common: CommonProps = useMemo(
    () => ({
      mode,
      onMode: setMode,
      connections: conns.data ?? [],
      connectionsLoaded: conns.data !== undefined,
      onOpenConnections: () => setConnDialog(true),
    }),
    [mode, conns.data],
  );

  // Both screens stay mounted so switching keeps their state; each has its own React Flow instance.
  return (
    <>
      <div className={clsx('h-full', mode !== 'map' && 'hidden')}>
        <ReactFlowProvider>
          <Canvas common={common} active={mode === 'map'} focus={focus} />
        </ReactFlowProvider>
      </div>
      <div className={clsx('h-full', mode !== 'build' && 'hidden')}>
        <ReactFlowProvider>
          <BuildView
            common={common}
            active={mode === 'build'}
            onShowOnMap={(id) => {
              setMode('map');
              setFocus({ id, n: Date.now() });
            }}
          />
        </ReactFlowProvider>
      </div>
      <ConnectionsDialog open={connDialog} onClose={() => setConnDialog(false)} connections={conns.data ?? []} />
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Shell />
      <Toaster theme="dark" position="bottom-right" richColors closeButton />
    </QueryClientProvider>
  );
}
