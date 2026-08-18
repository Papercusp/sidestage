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
    // SSE-first (WI-39855). The WEBSOCKETS rung resolves query names against
    // the Zero registry (libs/zero/src/queries.ts) instead of the REST
    // SyncQueryRegistry, and that contract is not yet row-compatible for the
    // queries this app consumes: catalog.page/inventory.page take different
    // args and return bare rows instead of the CatalogPage envelope, every
    // `.one()` query returns a bare object where call sites read `data[0]`,
    // and event.config / event.runOfShow / event.auction.active serve composed
    // REST views that ZQL cannot reproduce. Until per-query parity is proven
    // by test, WEBSOCKETS silently blanks those surfaces (that is what broke
    // the buyer drop runway in prod). SSE resolves every name over REST, the
    // contract all call sites were written against. Re-enable WEBSOCKETS only
    // together with the cutover plan's per-query parity gate.
    <SyncProvider
      syncType="SSE"
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
