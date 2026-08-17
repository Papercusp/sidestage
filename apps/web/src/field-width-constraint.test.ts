import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WI-39732 — APP-WIDE INVARIANT: a field label with a FIXED width must also
 * constrain the control inside it, or the control overflows the label and
 * whatever sits beside it paints on top.
 *
 * WHY THIS IS A SWEEP AND NOT A ONE-LINE ASSERTION. The reported bug (the red
 * "Take live" button sitting over the Minutes box in Event Manager) was not a
 * typo in one rule — it was a CLASS, and it was invisible three ways at once:
 *
 *   1. Every field label of this shape is `display: grid`, so its control is a
 *      GRID ITEM, and a grid item's `min-width: auto` resolves to its
 *      MIN-CONTENT size. For a bare `<input>` that comes from the default
 *      `size=20` attribute — ~249px here — so an unconstrained input simply
 *      refuses to shrink into a 5.5rem or 7rem label.
 *   2. Nothing clips, wraps, scrolls, or errors. The flex/grid siblings are
 *      laid out from the LABEL's declared width, so the overflow is painted
 *      OVER by whatever is to its right. The DOM is correct; only pixels lie.
 *   3. jsdom lays out neither grid nor flex, so no unit test that RENDERS the
 *      component can see it, and a typechecker never will. It was found by a
 *      human looking at a screenshot.
 *
 * That combination is why the same three lines went missing in three separate
 * places before anyone noticed. Live-measured before the fix:
 *   - lineup Minutes input   over "Take live"     85x27  (every row)
 *   - lineup Minutes input   over "Controls"      24x27  (every row)
 *   - drawer "Live quantity" over "Set quantity"  97x36
 *   - drawer "Auction qty"   over "Start price"   97x36
 *   - drawer "Start price"   over "Start auction" 97x36
 *   - offer  "Offer qty"     over "Offer price"  129x37
 *   - offer  "Offer price"   over "Send offer"    95x37
 *
 * So the check below deliberately scans EVERY stylesheet in apps/web/src
 * rather than asserting a string in one file. A new `.something-field { width:
 * 6rem }` added next month fails here instead of shipping the same defect a
 * fourth time.
 *
 * FALSIFIABILITY (tier 1 — no tree mutation). Every predicate is a pure
 * function run against the real stylesheets, which must pass, AND against
 * permanent deliberately-broken controls kept in this file, which must each be
 * DETECTED — including the exact pre-fix text of the rule the bug lived in.
 */

const webSrc = path.dirname(fileURLToPath(import.meta.url));

function stylesheets(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!/^(node_modules|dist|\.vite)$/.test(entry.name)) out.push(...stylesheets(full));
    } else if (entry.name.endsWith('.css')) {
      out.push(full);
    }
  }
  return out;
}

interface Rule {
  selectors: string[];
  decls: Record<string, string>;
}

/** Flat rule list; at-rule preludes are skipped, their inner rules still seen. */
export function parseRules(source: string): Rule[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorText = match[1].trim().replace(/^[\s\S]*\}/, '').trim();
    if (!selectorText || selectorText.startsWith('@')) continue;
    const decls: Record<string, string> = {};
    for (const decl of match[2].split(';')) {
      const idx = decl.indexOf(':');
      if (idx === -1) continue;
      decls[decl.slice(0, idx).trim()] = decl.slice(idx + 1).trim();
    }
    rules.push({ selectors: selectorText.split(',').map((s) => s.trim()), decls });
  }
  return rules;
}

/** A length that pins a box to a fixed size — what a control cannot shrink into. */
export function isFixedLength(value: string | undefined): boolean {
  return /^-?[\d.]+(rem|em|px|ch)$/.test((value ?? '').trim());
}

const CONTROLS = ['input', 'select', 'textarea'] as const;

/** Single-class selectors that declare a fixed width — the boxes at risk. */
export function fixedWidthBoxes(source: string): string[] {
  const found = new Set<string>();
  for (const rule of parseRules(source)) {
    if (!isFixedLength(rule.decls.width)) continue;
    for (const selector of rule.selectors) {
      if (/^\.[\w-]+$/.test(selector)) found.add(selector);
    }
  }
  return [...found];
}

/**
 * Does some rule constrain the width of `<box> <control>`?
 *
 * BOTH declarations are required, and `min-width` is the load-bearing one:
 * `width: 100%` alone is sufficient only while the label's own width is a
 * definite length (a definite specified size clamps the automatic minimum
 * size). Change that label to `flex: 1` or `width: auto` and `min-width: auto`
 * comes straight back — which is exactly how a fixed bug reopens quietly.
 */
export function controlWidthConstraint(
  source: string,
  box: string,
  control: string,
): { width: boolean; minWidth: boolean } {
  const target = `${box} ${control}`;
  let width = false;
  let minWidth = false;
  for (const rule of parseRules(source)) {
    if (!rule.selectors.includes(target)) continue;
    if (rule.decls.width) width = true;
    if (rule.decls['min-width'] === '0') minWidth = true;
  }
  return { width, minWidth };
}

/** Every `<fixed-width box> <control>` pair in `source` that is NOT constrained. */
export function unconstrainedControls(source: string): string[] {
  const violations: string[] = [];
  for (const box of fixedWidthBoxes(source)) {
    for (const control of CONTROLS) {
      // Only boxes that actually contain such a control can suffer this.
      const styled = new RegExp(`${box.replace('.', '\\.')}\\s+${control}\\b`);
      if (!styled.test(source)) continue;
      const constraint = controlWidthConstraint(source, box, control);
      if (!constraint.width || !constraint.minWidth) violations.push(`${box} ${control}`);
    }
  }
  return violations;
}

const sheets = stylesheets(webSrc).map((file) => ({
  file: path.relative(webSrc, file),
  css: readFileSync(file, 'utf8'),
}));

describe('a fixed-width field constrains its control (WI-39732)', () => {
  it('has stylesheets to check at all, so a green result is not an empty sweep', () => {
    expect(sheets.length).toBeGreaterThan(10);
    expect(sheets.some((s) => s.file === 'seller/lineup-timeline.css')).toBe(true);
    expect(sheets.some((s) => s.file === 'seller/offer-composer.css')).toBe(true);
  });

  it('finds the fixed-width field boxes these stylesheets actually declare', () => {
    // Fails loudly if the fields are renamed or restructured, rather than
    // reporting "no violations" because it stopped finding anything to check.
    const lineup = sheets.find((s) => s.file === 'seller/lineup-timeline.css')!.css;
    expect(fixedWidthBoxes(lineup)).toEqual(
      expect.arrayContaining(['.lineup-slot-minutes', '.lineup-drawer-field']),
    );
    const offer = sheets.find((s) => s.file === 'seller/offer-composer.css')!.css;
    expect(fixedWidthBoxes(offer)).toEqual(expect.arrayContaining(['.offer-composer-field']));
  });

  it('leaves NO fixed-width field with an unconstrained control, anywhere in apps/web', () => {
    const violations = sheets.flatMap(({ file, css }) =>
      unconstrainedControls(css).map((selector) => `${file}: ${selector}`),
    );
    expect(violations).toEqual([]);
  });

  it('constrains the Minutes field specifically — the reported collision', () => {
    const lineup = sheets.find((s) => s.file === 'seller/lineup-timeline.css')!.css;
    expect(controlWidthConstraint(lineup, '.lineup-slot-minutes', 'input')).toEqual({
      width: true,
      minWidth: true,
    });
  });
});

describe('permanent controls — each must be caught', () => {
  /** The lineup rule as it shipped, verbatim: fixed labels, unconstrained input. */
  const shippedBug = `
    .lineup-slot-minutes, .lineup-slot-notes, .lineup-drawer-field { display: grid; gap: .2rem; }
    .lineup-slot-minutes { width: 5.5rem; flex: 0 0 auto; }
    .lineup-drawer-field { width: 7rem; }
    .lineup-slot-minutes input, .lineup-slot-notes input, .lineup-drawer-field input {
      min-height: var(--ss-control-h); padding: 0 .5rem; border: 1px solid var(--border);
    }
  `;

  it('catches the exact stylesheet that shipped the bug', () => {
    expect(unconstrainedControls(shippedBug).sort()).toEqual([
      '.lineup-drawer-field input',
      '.lineup-slot-minutes input',
    ]);
  });

  it('catches the offer composer as it shipped', () => {
    const offerBug = `
      .offer-composer-field { display: grid; gap: .2rem; width: 7rem; }
      .offer-composer-field input { min-height: var(--ss-control-h); padding: 0 .5rem; }
    `;
    expect(unconstrainedControls(offerBug)).toEqual(['.offer-composer-field input']);
  });

  it('catches a HALF fix — width without min-width: 0', () => {
    const halfFixed = `
      .lineup-slot-minutes { width: 5.5rem; }
      .lineup-slot-minutes input { width: 100%; padding: 0 .5rem; }
    `;
    expect(unconstrainedControls(halfFixed)).toEqual(['.lineup-slot-minutes input']);
  });

  it('catches a HALF fix — min-width: 0 without a width', () => {
    const halfFixed = `
      .lineup-slot-minutes { width: 5.5rem; }
      .lineup-slot-minutes input { min-width: 0; padding: 0 .5rem; }
    `;
    expect(unconstrainedControls(halfFixed)).toEqual(['.lineup-slot-minutes input']);
  });

  it('catches a NEW fixed-width field added later without the constraint', () => {
    const regression = `
      .lineup-cue-field { display: grid; width: 6rem; }
      .lineup-cue-field input { min-height: var(--ss-control-h); }
    `;
    expect(unconstrainedControls(regression)).toEqual(['.lineup-cue-field input']);
  });

  it('catches a <select> and a <textarea>, not just <input>', () => {
    const other = `
      .some-field { width: 6rem; }
      .some-field select { padding: 0 .5rem; }
      .some-field textarea { padding: 0 .5rem; }
    `;
    expect(unconstrainedControls(other).sort()).toEqual(['.some-field select', '.some-field textarea']);
  });

  it('passes a correctly constrained field, so the check is not simply always-fail', () => {
    const correct = `
      .lineup-slot-minutes { width: 5.5rem; }
      .lineup-slot-minutes input { width: 100%; min-width: 0; padding: 0 .5rem; }
    `;
    expect(unconstrainedControls(correct)).toEqual([]);
  });

  it('does not fire on a fixed-width box that holds no control', () => {
    const innocent = `
      .lineup-slot-handle { width: 3rem; }
      .lineup-drawer-note { width: 8rem; }
    `;
    expect(unconstrainedControls(innocent)).toEqual([]);
  });

  it('does not fire on a fluid label, which has no automatic-minimum problem', () => {
    const fluid = `
      .lineup-slot-notes { width: 100%; }
      .lineup-slot-notes input { padding: 0 .5rem; }
    `;
    expect(unconstrainedControls(fluid)).toEqual([]);
  });
});

describe('the parser itself, so a silent parse failure cannot read as "clean"', () => {
  it('reads selectors and declarations, and ignores comments', () => {
    const rules = parseRules('/* .fake { width: 1rem } */ .a, .b { width: 2rem; min-width: 0 }');
    expect(rules).toEqual([{ selectors: ['.a', '.b'], decls: { width: '2rem', 'min-width': '0' } }]);
  });

  it('recognises fixed lengths and rejects fluid ones', () => {
    expect(['5.5rem', '7rem', '120px', '20ch'].every(isFixedLength)).toBe(true);
    expect(['100%', 'auto', 'min-content', 'var(--w)', undefined].some(isFixedLength)).toBe(false);
  });

  it('actually parsed the real stylesheets rather than yielding nothing', () => {
    const lineup = sheets.find((s) => s.file === 'seller/lineup-timeline.css')!.css;
    expect(parseRules(lineup).length).toBeGreaterThan(20);
  });
});
