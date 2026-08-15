import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArchitectureTab } from './ArchitectureTab';

const css = readFileSync(new URL('./architecture.css', import.meta.url), 'utf8');

describe('ArchitectureTab', () => {
  it('documents every SideStage architecture layer and its core runtime flows', () => {
    const markup = renderToStaticMarkup(<ArchitectureTab />);

    for (const heading of [
      'The whole system at a glance',
      'Three flows define the runtime',
      'Application layers',
      'Data is organized around ownership and invariants',
      'From source tree to production',
    ]) expect(markup).toContain(heading);

    for (const system of [
      'React single-page app', 'NestJS modular API', 'PostgreSQL + Typesense',
      'MediaMTX + coturn', 'Stripe + EasyPost', 'Deepgram + model provider',
      '@papercusp/sync', 'system-test-worker',
    ]) expect(markup).toContain(system);

    expect(markup).toContain('The browser proposes. The server decides.');
    expect(markup).toContain('Buyer-visible effect');
    expect(markup).toContain('aria-label="Architecture sections"');
  });

  it('keeps diagrams responsive without hiding architecture content', () => {
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.architecture-context-diagram\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.architecture-layer > div[^}]*grid-template-columns:\s*1fr/);
    expect(css).not.toMatch(/@media[^}]+display:\s*none/);
  });
});
