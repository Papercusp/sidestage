import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  SIDE_STAGE_SCOUT_STRINGS,
  buyerScoutResources,
  handleBuyerScoutAppEvent,
} from './BuyerScoutDrawer';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');

export function rendersBuyerRailDirectly(source: string): boolean {
  return /const renderProducts\s*=\s*\([^)]*\)\s*=>\s*\{[\s\S]*?return\s*\(\s*<BuyerProductRail\b/.test(source);
}

/**
 * P-001 guard: every root BuyerProductRail can render spans the whole result row.
 *
 * WHY THIS IS DERIVED AND NOT A LITERAL SELECTOR CHECK. The first version of
 * this guard regexed one block -- `.sc-products > .buyer-product-rail { ... }`
 * -- and passed. It had two holes, both silent. (1) That block is SHARED by a
 * selector list, so deleting the `.buyer-product-rail-wrap` line left the guard
 * green while the >=2-product branch (the common one) collapsed back into a
 * single grid column. (2) It only ever knew about the one class someone
 * happened to write down, so the `products.length === 0` branch --
 * `.buyer-rail-empty` -- was never covered at all, and the end-of-drop notice
 * shipped one-track for nine days.
 *
 * So neither side is hand-listed. `railRootClassNames` reads the branch roots
 * out of the component, `fullWidthResultSelectors` reads the covered classes
 * out of the stylesheet, and the test asserts containment. A new render branch
 * fails here instead of shipping narrow.
 *
 * FALSIFIABILITY (tier 1 -- no tree mutation, matching buyer-tab-fixed-layout).
 * Both predicates are pure and are exercised below against the real subject,
 * which must pass, and against deliberately-wrong inputs kept permanently in
 * this file, which must fail. A derivation that silently returned nothing would
 * make containment vacuously true, so the real-subject test also calibrates:
 * it asserts the three known branches are actually discovered.
 */
export function railRootClassNames(source: string): string[] {
  const start = source.indexOf(': BuyerProductRailProps) {');
  const end = source.indexOf('export default');
  if (start < 0 || end < 0 || end < start) return [];
  const body = source.slice(start, end);

  const firstClassOf = (jsx: string): string | undefined =>
    jsx.match(/<[A-Za-z][^>]*?\sclassName="([^"]+)"/)?.[1]?.trim().split(/\s+/)[0];

  const roots = new Set<string>();
  for (const [, inlineJsx, identifier] of body.matchAll(
    /\breturn\s+(?:\(([\s\S]*?)\n\s*\);|([A-Za-z_$][\w$]*)\s*;)/g,
  )) {
    // `return <identifier>;` -- resolve the JSX through its const binding.
    const jsx = inlineJsx
      ?? (identifier
        ? body.match(new RegExp(`const\\s+${identifier}\\s*=\\s*\\(([\\s\\S]*?)\\n\\s*\\);`))?.[1]
        : undefined);
    const className = jsx ? firstClassOf(jsx) : undefined;
    if (className) roots.add(className);
  }
  return [...roots];
}

export function fullWidthResultSelectors(styles: string): string[] {
  // Strip comments first: they land inside the selector capture below, and a
  // comma in prose would otherwise fragment the selector list and silently drop
  // whichever class follows it.
  const source = styles.replace(/\/\*[\s\S]*?\*\//g, '');
  const covered: string[] = [];
  for (const [, selectors, declarations] of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/grid-column\s*:\s*1\s*\/\s*-1\s*;/.test(declarations)) continue;
    if (!/min-width\s*:\s*0\s*;/.test(declarations)) continue;
    for (const selector of selectors.split(',')) {
      const className = selector.trim().match(/^\.sc-products\s*>\s*\.([A-Za-z0-9_-]+)$/)?.[1];
      if (className) covered.push(className);
    }
  }
  return covered;
}

describe('BuyerScoutDrawer contract', () => {
  it('describes device continuity without claiming private per-user memory', () => {
    const copy = JSON.stringify(SIDE_STAGE_SCOUT_STRINGS).toLowerCase();
    expect(copy).toContain('this device');
    expect(copy).not.toContain('private');
    expect(copy).not.toContain('only you');
  });

  it('opens the existing held-items drawer for cart app events only', () => {
    const openHeldItems = vi.fn();
    handleBuyerScoutAppEvent({ type: 'cart_mutate' }, openHeldItems);
    handleBuyerScoutAppEvent({ type: 'open_drawer', which: 'cart' }, openHeldItems);
    handleBuyerScoutAppEvent({ type: 'open_drawer', which: 'quote' }, openHeldItems);
    handleBuyerScoutAppEvent({ type: 'token', content: 'hi' }, openHeldItems);
    expect(openHeldItems).toHaveBeenCalledTimes(2);
  });

  it('gives every BuyerProductRail render branch the full Scout result width', () => {
    const drawer = read('./BuyerScoutDrawer.tsx');
    const rail = read('./BuyerProductRail.tsx');
    const styles = read('./BuyerProductRail.css');

    expect(rendersBuyerRailDirectly(drawer)).toBe(true);

    const roots = railRootClassNames(rail);
    // Calibration: containment below is vacuous if the derivation finds nothing,
    // so pin the branches we know the component has (empty / single / multiple).
    expect(roots).toEqual(
      expect.arrayContaining(['buyer-rail-empty', 'buyer-product-rail', 'buyer-product-rail-wrap']),
    );

    const covered = fullWidthResultSelectors(styles);
    for (const className of roots) expect(covered).toContain(className);
  });

  it('does not mount the full chat surface while its drawer is closed', () => {
    const drawer = read('./BuyerScoutDrawer.tsx');
    expect(drawer).toContain('{({ close, otherOpen, open }) => open ? (');
    expect(drawer).toMatch(/open \? \(\s*<ScoutChat[\s\S]*?\) : null}/);
  });

  it('restores only the matching buyer conversation across A → B → A switches', () => {
    const buyerA = buyerScoutResources('buyer-switch-a');
    const buyerB = buyerScoutResources('buyer-switch-b');
    buyerA.conversation.sessionId = 'session-a';
    buyerB.conversation.sessionId = 'session-b';

    expect(buyerScoutResources('buyer-switch-a').conversation).toBe(buyerA.conversation);
    expect(buyerScoutResources('buyer-switch-a').conversation.sessionId).toBe('session-a');
    expect(buyerB.conversation).not.toBe(buyerA.conversation);
    expect(buyerB.sessionStorageKey).not.toBe(buyerA.sessionStorageKey);
  });

  it('detects the original one-track regression', () => {
    expect(fullWidthResultSelectors(`
      .sc-products { display: grid; grid-template-columns: repeat(3, 1fr); }
    `)).toEqual([]);
  });

  it('detects a selector dropped from the shared full-width block', () => {
    // The hole the first version of this guard could not see: the block is a
    // selector LIST, so losing one line still leaves a matching block behind.
    const withoutWrap = `
      .sc-products > .buyer-product-rail,
      .sc-products > .buyer-rail-empty {
        min-width: 0;
        grid-column: 1 / -1;
      }
    `;
    expect(fullWidthResultSelectors(withoutWrap)).not.toContain('buyer-product-rail-wrap');
  });

  it('reads selectors that sit behind a comment containing commas', () => {
    // Regression on the guard itself: an un-stripped comment lands in the
    // selector capture, and its commas split the list, dropping the class that
    // follows. That silently under-reported coverage rather than failing.
    expect(fullWidthResultSelectors(`
      /* one root, then another, then a third */
      .sc-products > .buyer-product-rail-wrap,
      .sc-products > .buyer-product-rail {
        min-width: 0;
        grid-column: 1 / -1;
      }
    `)).toEqual(['buyer-product-rail-wrap', 'buyer-product-rail']);
  });

  it('detects a full-width block that declares the span without min-width', () => {
    // grid-column alone still lets a wide card force the track open.
    expect(fullWidthResultSelectors(`
      .sc-products > .buyer-product-rail { grid-column: 1 / -1; }
    `)).toEqual([]);
  });

  it('derives a new render branch so an uncovered one cannot ship narrow', () => {
    const componentWithNewBranch = `
      function BuyerProductRail({ products }: BuyerProductRailProps) {
        if (products.length === 0) {
          return (
            <div className="buyer-rail-empty" role="status">nothing</div>
          );
        }
        const rail = (
          <ul className="buyer-product-rail">{null}</ul>
        );
        if (products.length <= 1) {
          return rail;
        }
        return (
          <section className="buyer-rail-carousel">{rail}</section>
        );
      }
      export default BuyerProductRail;
    `;
    const roots = railRootClassNames(componentWithNewBranch);
    expect(roots).toContain('buyer-rail-carousel');
    // ...and the real stylesheet does not cover that hypothetical branch.
    expect(fullWidthResultSelectors(read('./BuyerProductRail.css'))).not.toContain(
      'buyer-rail-carousel',
    );
  });

  it('goes red when a real branch loses its full-width selector', () => {
    // End-to-end falsifiability against the REAL subject, with no tree mutation:
    // drop one selector from an in-memory copy of the stylesheet and confirm the
    // assembled roots-are-covered check stops holding.
    const original = read('./BuyerProductRail.css');
    const mutated = original.replace(/,\s*\.sc-products\s*>\s*\.buyer-rail-empty\s*\{/, ' {');
    expect(mutated).not.toBe(original); // a no-op mutation would prove nothing

    const roots = railRootClassNames(read('./BuyerProductRail.tsx'));
    const covered = fullWidthResultSelectors(mutated);
    expect(roots).toContain('buyer-rail-empty');
    expect(covered).not.toContain('buyer-rail-empty');
  });

  it('reports no branches when the component shape stops being recognizable', () => {
    // Guards the calibration above: an unrecognized shape must read as EMPTY
    // (loudly failing the real-subject test) rather than as "all covered".
    expect(railRootClassNames('export function somethingElse() { return null; }')).toEqual([]);
  });
});
