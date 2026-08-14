import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * P-012 guard: the Buyer tab stays a FIXED layout.
 *
 * The dockview port (P-007..P-011) was scoped to the Seller tab only. The
 * regression it invites is quiet and one-directional: a later change reaches
 * for a dock panel from the Buyer tab "just for this one section", and the
 * Buyer tab silently becomes draggable/resizable/closable. Nothing fails when
 * that happens — it typechecks, it renders, and every seller-dock suite stays
 * green, because the seller dock is not what broke.
 *
 * WHY THIS IS A COUPLING GUARD AND NOT A BYTE SNAPSHOT. P-012 words the
 * requirement as "Buyer tab stays byte-identical fixed layout". A literal
 * byte hash of BuyerTab.tsx would be the wrong instrument: the Buyer tab is
 * under active, legitimate development (thumbnails, auction panel, channel
 * guide), so a hash would fail on every unrelated edit and be deleted within a
 * day. What must stay invariant is not the bytes — it is that the Buyer tab
 * takes NO dependency on the dock surface and keeps its own fixed shell. That
 * property survives ordinary Buyer edits and fails exactly when the port leaks.
 *
 * FALSIFIABILITY (tier 1 — no tree mutation). Every predicate is a pure
 * function exercised against three inputs: the real subject, which must pass;
 * a CALIBRATION case — the real SellerTab.tsx, which genuinely does couple to
 * the dock and must be DETECTED, so that a clean verdict on BuyerTab means
 * "no coupling" rather than "the detector is broken"; and permanent
 * deliberately-broken controls kept here as fixtures.
 */

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

/** Every module specifier the source imports, including multi-line and side-effect forms. */
export function importedSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  return specs;
}

/** Does this specifier reach the dockview surface? */
export function isDockSpecifier(spec: string): boolean {
  const s = spec.toLowerCase();
  return (
    s.includes('dockview') ||
    s.includes('dock-workbench') ||
    s.includes('seller-dock') ||
    /(^|\/)sellerdock$/.test(s)
  );
}

export function dockCouplings(source: string): string[] {
  return importedSpecifiers(source).filter(isDockSpecifier);
}

/** The Buyer tab's own fixed shell: a plain section, not a dock container. */
export function hasFixedLayoutRoot(source: string): boolean {
  return /className=["'][^"']*\bbuyer-tab\b/.test(source);
}

const buyerTab = read('./BuyerTab.tsx');
const sellerTab = read('./SellerTab.tsx');

describe('Buyer tab stays a fixed layout (P-012)', () => {
  it('takes no dependency on the dock surface', () => {
    expect(dockCouplings(buyerTab)).toEqual([]);
  });

  it('keeps its own fixed shell rather than a dock container', () => {
    expect(hasFixedLayoutRoot(buyerTab)).toBe(true);
  });
});

describe('calibration — the detector actually detects', () => {
  /**
   * Without this, the assertion above is unfalsifiable: a predicate that never
   * returns true would report the Buyer tab clean forever. The Seller tab is
   * the real, live positive case.
   */
  it('reports the Seller tab AS coupled, because it genuinely is', () => {
    expect(dockCouplings(sellerTab).length).toBeGreaterThan(0);
  });

  it('names the specifiers rather than just counting them', () => {
    expect(dockCouplings(sellerTab).some((s) => s.toLowerCase().includes('sellerdock'))).toBe(true);
  });
});

describe('permanent controls — each must be caught', () => {
  const controls: Array<[string, string]> = [
    ['direct SellerDock import', `import { SellerDock } from './SellerDock';`],
    ['panel registry import', `import { sellerPanelRegistry } from './seller-dock-panels';`],
    ['library import', `import { DockviewReact } from 'dockview';`],
    ['workbench import', `import { DockWorkspace } from '@papercusp/dock-workbench';`],
    ['side-effect css import', `import 'dockview/dist/styles/dockview.css';`],
    [
      'multi-line import, the form a one-line regex misses',
      `import {\n  SellerDock,\n  SELLER_DOCK_CLASS_NAME,\n} from './SellerDock';`,
    ],
  ];

  for (const [name, source] of controls) {
    it(`catches: ${name}`, () => {
      expect(dockCouplings(source).length).toBeGreaterThan(0);
    });
  }

  it('does NOT fire on Buyer-tab imports that merely look adjacent', () => {
    const innocent = [
      `import { AuctionPanel } from './AuctionPanel';`,
      `import { BuyerProductRail } from './BuyerProductRail';`,
      `import { EventChat } from './EventChat';`,
      `import { ReplayChapters } from './ReplayChapters';`,
    ].join('\n');
    expect(dockCouplings(innocent)).toEqual([]);
  });

  it('a source with no fixed shell fails the shell predicate', () => {
    expect(hasFixedLayoutRoot(`<section className="seller-tab">`)).toBe(false);
  });
});
