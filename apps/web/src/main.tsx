import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SyncProvider } from '@papercusp/sync';
// ONE package imported identically by the browser and by the API's zero-cache
// /query and /mutate handlers — importing the same module on both sides of the
// sync boundary is what makes schema/query/mutator drift impossible by
// construction rather than by review.
import { schema, queries, createMutators } from '@papercusp/sidestage-zero';
import { ActiveNowComparison, isActiveNowComparisonPath } from './ActiveNowComparison';
import { App } from './App';
import { resolveApiBaseUrl, resolveZeroServerUrl } from './catalog';
import { useDemoIdentity } from './buyer-identity';
import './styles.css';
// Maps the shared drawer libs' public --cd-*/--sc-* tokens onto SideStage's own
// palette. Imported AFTER styles.css because it references those tokens by name
// (--bg, --surface, --brand-red, …); the libs' own sheets ship dark-host
// defaults, so without this the drawers render Restart's palette in a cream app.
import './shared-drawer-theme.css';
import { applyGridTheme } from './grid-theme-bridge';

// papergrid ships a neutral DARK palette and expects the host to inject its own via
// configureGridColors(). This must run after styles.css is imported (the tokens it reads are
// defined there) and before the first render, so no grid paints the library default.
applyGridTheme();

const syncEndpoint = `${resolveApiBaseUrl()}/sync`;
const zeroServer = resolveZeroServerUrl();

// Pure registry construction — no connection, no side effects. Built once at
// module scope so the mutator object identity is stable across re-renders.
const mutators = createMutators();

function SideStageSyncRoot() {
  const { userId } = useDemoIdentity();
  return (
    // WebSockets-first. The provider probes the zero-cache upgrade once per
    // session and steps down WEBSOCKETS → SSE → bounded POLLING on reachability
    // failure only; `restEndpoint`/`endpointOverride` stay wired so those lower
    // rungs keep hitting the right API endpoints when they are used.
    <SyncProvider
      syncType="WEBSOCKETS"
      userId={userId}
      server={zeroServer}
      schema={schema}
      queries={queries}
      mutators={mutators}
      restEndpoint={syncEndpoint}
      endpointOverride={`${syncEndpoint}/sse`}
      pollIntervalMs={10_000}
    >
      <App />
    </SyncProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isActiveNowComparisonPath(window.location.pathname)
      ? <ActiveNowComparison />
      : <SideStageSyncRoot />}
  </StrictMode>,
);
