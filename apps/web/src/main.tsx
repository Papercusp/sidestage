import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { applyGridTheme } from './grid-theme-bridge';

// papergrid ships a neutral DARK palette and expects the host to inject its own via
// configureGridColors(). This must run after styles.css is imported (the tokens it reads are
// defined there) and before the first render, so no grid paints the library default.
applyGridTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
