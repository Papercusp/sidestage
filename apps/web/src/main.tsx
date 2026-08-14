import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SyncProvider } from '@papercusp/sync';
import { App } from './App';
import { resolveApiBaseUrl } from './catalog';
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SyncProvider
      syncType="SSE"
      restEndpoint={syncEndpoint}
      endpointOverride={`${syncEndpoint}/sse`}
      pollIntervalMs={10_000}
    >
      <App />
    </SyncProvider>
  </StrictMode>,
);
