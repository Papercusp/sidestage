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
      'How the mobile apps are built',
      'How the test framework works',
      'From source tree to production',
    ]) expect(markup).toContain(heading);

    // The deep-dive sections each ship their flow diagram and jump-nav entry.
    for (const anchor of ['#search', '#data-sync', '#checkout', '#data-model', '#mobile-apps', '#testing']) expect(markup).toContain(`href="${anchor}"`);
    for (const claim of [
      'Hybrid rank fusion',
      'Server-authoritative writes',
      'Webhook authority',
      'GENERATED ALWAYS AS',
      'Shared Rust core',
      'Deterministic reply judge',
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

  // Plan decision sidestage-websocket-sync-cutover-2026-08-17#D-006: this page describes the sync
  // transport as DESIGNED behavior. The WebSocket rung does not win today (no zero-cache origin
  // answers the probe), so copy asserting realtime already runs over WebSockets is false, and the
  // mid-cutover "SSE remains the live transport until rollout completes" caveat is stale.
  // When the WS rung really does start serving, the "rung serving today" assertion below is MEANT
  // to fail — that forces a deliberate copy update instead of letting the page quietly go wrong.
  it('describes the sync transport as a designed ladder without claiming WebSockets serve today', () => {
    const markup = renderToStaticMarkup(<ArchitectureTab />);

    // The whole ladder is stated, floor included — not just its top rung.
    expect(markup).toContain('zero-cache');
    expect(markup).toContain('@papercusp/sidestage-zero');
    expect(markup).toMatch(/bounded polling/i);
    expect(markup).toMatch(/SSE is the rung serving today/i);

    // The stale mid-cutover caveat must not return.
    expect(markup).not.toMatch(/Cutover in progress/i);

    // The SSE-only realtime claims P-006 replaced must not return.
    // The precise former label — not a loose 'SSE · WebRTC' fragment, which the current
    // 'HTTPS · WebSocket → SSE · WebRTC' ladder legitimately contains.
    expect(markup).not.toContain('HTTPS · SSE · WebRTC');
    expect(markup).not.toContain('WHEP video + SSE state');
    expect(markup).not.toContain('SSE reconnects and refreshes affected queries');
    expect(markup).not.toContain('Query registry, batched reads, mutations, SSE invalidation');
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
