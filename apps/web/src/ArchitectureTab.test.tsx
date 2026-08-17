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
      'How search works',
      'How data syncing works',
      'How checkout works',
      'The data model',
      'Application layers',
      'Data is organized around ownership and invariants',
      'From source tree to production',
    ]) expect(markup).toContain(heading);

    // The four deep-dive sections each ship their flow diagram and jump-nav entry.
    for (const anchor of ['#search', '#data-sync', '#checkout', '#data-model']) expect(markup).toContain(`href="${anchor}"`);
    for (const claim of [
      'Hybrid rank fusion',
      'Targeted refresh',
      'Webhook authority',
      'GENERATED ALWAYS AS',
    ]) expect(markup).toContain(claim);

    for (const system of [
      'React single-page app', 'NestJS modular API', 'PostgreSQL + Typesense',
      'MediaMTX + coturn', 'Stripe + EasyPost', 'Deepgram + model provider',
      '@papercusp/sync', 'system-test-worker',
    ]) expect(markup).toContain(system);

    expect(markup).toContain('The browser proposes. The server decides.');
    expect(markup).toContain('Buyer-visible effect');
    expect(markup).toContain('aria-label="Architecture sections"');
    expect(markup).toContain('class="architecture-layout"');
    expect(markup).toContain('class="architecture-content"');
    expect(markup).toContain('On this page');
  });

  it('uses a sticky section sidebar and keeps the page responsive without hiding content', () => {
    expect(css).toMatch(/\.architecture-layout\s*\{[^}]*grid-template-columns:\s*minmax\(9\.5rem, 12rem\) minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.architecture-jump-nav\s*\{[^}]*position:\s*sticky[^}]*top:\s*var\(--architecture-sticky-top\)[^}]*display:\s*grid/);
    expect(css).not.toMatch(/\.architecture-jump-nav\s*\{[^}]*display:\s*flex/);
    expect(css).toMatch(/\.architecture-section\s*\{[^}]*scroll-margin-top:\s*calc\(var\(--architecture-sticky-top\) \+ \.75rem\)/);
    expect(css).toMatch(/@media \(min-width: 1300px\) and \(max-width: 1699px\)[\s\S]*?--architecture-sticky-top:\s*11rem/);
    expect(css).toMatch(/@media \(min-width: 901px\) and \(max-width: 1299px\)[\s\S]*?--architecture-sticky-top:\s*14\.5rem/);
    expect(css).toMatch(/@media \(min-width: 721px\) and \(max-width: 900px\)[\s\S]*?--architecture-sticky-top:\s*18rem/);
    expect(css).toMatch(/@media \(max-width: 1100px\)[\s\S]*?\.architecture-context-diagram\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.architecture-layout\s*\{[^}]*grid-template-columns:\s*1fr/);
    expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.architecture-layer > div[^}]*grid-template-columns:\s*1fr/);
    expect(css).not.toMatch(/@media[^}]+display:\s*none/);
  });
});
