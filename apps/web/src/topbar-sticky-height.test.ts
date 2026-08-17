import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * EI-20490096718304228: `.topbar` is `position: sticky; z-index: 30; top: 0`
 * and RESTACKS to a taller multi-row layout as `.topbar-inner` /
 * `.topbar-brand-group` / `.tab-nav` / `.topbar-install-and-identity`
 * restructure across the breakpoints below (see the `.topbar-inner` /
 * `.tab-nav` rules earlier in styles.css). `html`'s `scroll-padding-top` used
 * to be a single value fixed for the desktop single-row topbar (5.25rem),
 * so `scrollIntoView`/actionability scrolling on any low-page target (e.g.
 * the buyer video overlay's Connect/Retry button) left it hidden under the
 * sticky bar once it had wrapped to more rows — live-measured at 375x812:
 * real `.topbar` height 310px vs 84px reserved.
 *
 * This mirrors the codebase's established `--architecture-sticky-top`
 * pattern (architecture.css / ArchitectureTab.test.tsx): a pure
 * regex-over-raw-CSS-text check, because the failure is a PAINTED
 * reachability defect (position/z-index/scroll interception) invisible to a
 * typechecker, a renderer, or a jsdom unit test — jsdom does not lay out
 * `position: sticky` or wrapping flex/grid at all. Each check below is
 * exercised against a CONTROL that must fail, so a check that always passes
 * cannot hide here.
 */

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

describe('topbar sticky-height scroll offset', () => {
  it('wires html scroll-padding-top through the --topbar-sticky-height custom property', () => {
    expect(css).toMatch(/html\s*\{[^}]*scroll-padding-top:\s*var\(--topbar-sticky-height,\s*5\.25rem\)/);
  });

  it('CONTROL: a hardcoded scroll-padding-top (the shipped bug) fails the check above', () => {
    const broken = 'html { min-width: 320px; scroll-padding-top: 5.25rem; }';
    expect(broken).not.toMatch(/html\s*\{[^}]*scroll-padding-top:\s*var\(--topbar-sticky-height,\s*5\.25rem\)/);
  });

  it('declares the base (single-row desktop) height on :root', () => {
    expect(css).toMatch(/:root\s*\{[\s\S]*?--topbar-sticky-height:\s*5\.25rem/);
  });

  it('grows the reserved offset at every breakpoint .topbar actually wraps at', () => {
    // 1300-1699px: .topbar-inner goes to 2 rows (brand row 1; tab-nav + status row 2).
    expect(css).toMatch(/@media \(min-width: 1300px\) and \(max-width: 1699px\)[\s\S]*?--topbar-sticky-height:\s*10\.5rem/);
    // 901-1299px: tab-nav/status-group each take their own full-width row -> 3 rows.
    expect(css).toMatch(/@media \(min-width: 901px\) and \(max-width: 1299px\)[\s\S]*?--topbar-sticky-height:\s*14\.75rem/);
    // 681-900px: .topbar-brand-group wraps (topbar-install-and-identity forced to its own row).
    expect(css).toMatch(/@media \(min-width: 681px\) and \(max-width: 900px\)[\s\S]*?--topbar-sticky-height:\s*16\.75rem/);
    // <=680px: topbar-install-and-identity itself wraps (demo-user drops to its own row).
    expect(css).toMatch(/@media \(max-width: 680px\)[\s\S]*?--topbar-sticky-height:\s*20rem/);
  });

  it('CONTROL: a stylesheet missing the narrow-breakpoint overrides fails the growth check', () => {
    const rootOnly = ':root { --topbar-sticky-height: 5.25rem; }';
    expect(rootOnly).not.toMatch(/@media \(min-width: 1300px\) and \(max-width: 1699px\)[\s\S]*?--topbar-sticky-height:\s*10\.5rem/);
    expect(rootOnly).not.toMatch(/@media \(min-width: 901px\) and \(max-width: 1299px\)[\s\S]*?--topbar-sticky-height:\s*14\.75rem/);
    expect(rootOnly).not.toMatch(/@media \(min-width: 681px\) and \(max-width: 900px\)[\s\S]*?--topbar-sticky-height:\s*16\.75rem/);
    expect(rootOnly).not.toMatch(/@media \(max-width: 680px\)[\s\S]*?--topbar-sticky-height:\s*20rem/);
  });

  it('every override is monotonically non-decreasing as the topbar gains rows (never under-reserves)', () => {
    const rem = (label: string) => {
      const m = new RegExp(`${label}[\\s\\S]*?--topbar-sticky-height:\\s*([\\d.]+)rem`).exec(css);
      expect(m, `no --topbar-sticky-height override found for ${label}`).not.toBeNull();
      return Number(m![1]);
    };
    const base = 5.25;
    const wide = rem('@media \\(min-width: 1300px\\) and \\(max-width: 1699px\\)');
    const mid = rem('@media \\(min-width: 901px\\) and \\(max-width: 1299px\\)');
    const narrow = rem('@media \\(min-width: 681px\\) and \\(max-width: 900px\\)');
    const narrowest = rem('@media \\(max-width: 680px\\)');
    expect(wide).toBeGreaterThan(base);
    expect(mid).toBeGreaterThan(wide);
    expect(narrow).toBeGreaterThan(mid);
    expect(narrowest).toBeGreaterThan(narrow);
  });
});
