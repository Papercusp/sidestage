import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WI-39732: a lineup field whose LABEL has a fixed width must also constrain
 * the `<input>` inside it, or the input overflows the label and the controls
 * beside it paint on top.
 *
 * WHY THIS IS A GUARD AND NOT A ONE-LINE ASSERTION. The shipped bug was not a
 * typo — it was a whole CLASS, invisible three ways at once:
 *
 *   1. Every field label here is `display: grid`, so its input is a GRID ITEM,
 *      and a grid item's `min-width: auto` resolves to its MIN-CONTENT size.
 *      For a bare `<input>` that comes from the default `size=20` attribute
 *      (~249px), so the input simply refuses to shrink into a 5.5rem or 7rem
 *      label.
 *   2. Nothing clips, wraps, scrolls or errors. The flex/grid siblings are laid
 *      out from the LABEL's declared width, so the overflow is painted OVER by
 *      whatever sits to its right. The DOM is correct; only the pixels are wrong.
 *   3. jsdom does not lay out grid or flex at all, so no unit test that renders
 *      LineupTimeline can see it, and a typechecker never will. It was found by
 *      a human looking at a screenshot.
 *
 * Live-measured before the fix (localhost:5173, real rendered rows): the
 * Minutes input overlapped "Take live" by 85x27px and "Controls" by 24x27px on
 * every row, and in the Controls drawer "Live quantity" sat under "Set
 * quantity" (97x36), "Auction qty" under "Start price" (97x36), and "Start
 * price" under "Start auction" (97x36). Eight collisions from one missing pair
 * of declarations.
 *
 * So the assertion below is deliberately NOT "the file contains min-width: 0".
 * It is the INVARIANT: every fixed-width field label in this stylesheet has a
 * width-constrained input. That is what makes a NEW `.lineup-something-field {
 * width: 6rem }` added next month fail here instead of shipping the same
 * defect again.
 *
 * FALSIFIABILITY (tier 1 — no tree mutation). Every predicate is a pure
 * function run against the real stylesheet, which must pass, AND against
 * permanent deliberately-broken controls kept in this file, which must each be
 * DETECTED — including the exact pre-fix text of the rule this bug lived in.
 */

const css = readFileSync(new URL('./lineup-timeline.css', import.meta.url), 'utf8');

interface Rule {
  selectors: string[];
  decls: Record<string, string>;
}

/** Flat rule list. Nested at-rules are not used in this stylesheet's field section. */
export function parseRules(source: string): Rule[] {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Rule[] = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectorText = match[1].trim();
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

/** A length that pins a box to a fixed size — the thing an input cannot shrink into. */
function isFixedLength(value: string): boolean {
  return /^-?[\d.]+(rem|em|px|ch)$/.test(value.trim());
}

/**
 * Field labels that declare a fixed width. These are the boxes an unconstrained
 * input overflows; `%`, `auto`, `min-content` and friends are not at risk.
 */
export function fixedWidthFieldSelectors(source: string): string[] {
  const found = new Set<string>();
  for (const rule of parseRules(source)) {
    const width = rule.decls.width;
    if (!width || !isFixedLength(width)) continue;
    for (const selector of rule.selectors) {
      if (/^\.[\w-]+$/.test(selector)) found.add(selector);
    }
  }
  return [...found];
}

/**
 * Does some rule constrain the width of `<selector> input`?
 *
 * BOTH declarations are required, and the second is the load-bearing one:
 * `width: 100%` alone happens to be sufficient only while the label's width is
 * a definite length (a definite specified size clamps the automatic minimum
 * size). Change that label to `flex: 1` or `width: auto` and `min-width: auto`
 * comes straight back — which is exactly how a fixed bug reopens quietly.
 */
export function inputWidthConstraint(source: string, selector: string): { width: boolean; minWidth: boolean } {
  const target = `${selector} input`;
  let width = false;
  let minWidth = false;
  for (const rule of parseRules(source)) {
    if (!rule.selectors.includes(target)) continue;
    if (rule.decls.width) width = true;
    if (rule.decls['min-width'] === '0') minWidth = true;
  }
  return { width, minWidth };
}

export function unconstrainedFields(source: string): string[] {
  return fixedWidthFieldSelectors(source).filter((selector) => {
    // Only fields that actually contain an input can suffer this.
    if (!new RegExp(`${selector.replace('.', '\\.')}\\s+input\\b`).test(source)) return false;
    const constraint = inputWidthConstraint(source, selector);
    return !constraint.width || !constraint.minWidth;
  });
}

describe('lineup fields: a fixed-width label constrains its input (WI-39732)', () => {
  it('finds the fixed-width field labels this stylesheet actually declares', () => {
    // Fails loudly if the fields are renamed or restructured, rather than
    // reporting "0 violations" because it stopped finding anything to check.
    expect(fixedWidthFieldSelectors(css).sort()).toEqual(
      expect.arrayContaining(['.lineup-drawer-field', '.lineup-slot-minutes']),
    );
  });

  it('leaves no fixed-width field with an unconstrained input', () => {
    expect(unconstrainedFields(css)).toEqual([]);
  });

  it('constrains the Minutes field specifically — the reported collision', () => {
    expect(inputWidthConstraint(css, '.lineup-slot-minutes')).toEqual({ width: true, minWidth: true });
  });

  it('constrains the Controls-drawer fields — the same defect, one surface over', () => {
    expect(inputWidthConstraint(css, '.lineup-drawer-field')).toEqual({ width: true, minWidth: true });
  });
});

describe('permanent controls — each must be caught', () => {
  /** The rule as it shipped, verbatim: fixed label, unconstrained input. */
  const shippedBug = `
    .lineup-slot-minutes, .lineup-slot-notes, .lineup-drawer-field { display: grid; gap: .2rem; }
    .lineup-slot-minutes { width: 5.5rem; flex: 0 0 auto; }
    .lineup-drawer-field { width: 7rem; }
    .lineup-slot-minutes input, .lineup-slot-notes input, .lineup-drawer-field input {
      min-height: var(--ss-control-h); padding: 0 .5rem; border: 1px solid var(--border);
    }
  `;

  it('catches the exact stylesheet that shipped the bug', () => {
    expect(unconstrainedFields(shippedBug).sort()).toEqual(['.lineup-drawer-field', '.lineup-slot-minutes']);
  });

  it('catches a HALF fix — width: 100% without min-width: 0', () => {
    const halfFixed = `
      .lineup-slot-minutes { width: 5.5rem; }
      .lineup-slot-minutes input { width: 100%; padding: 0 .5rem; }
    `;
    expect(unconstrainedFields(halfFixed)).toEqual(['.lineup-slot-minutes']);
  });

  it('catches a HALF fix — min-width: 0 without a width', () => {
    const halfFixed = `
      .lineup-slot-minutes { width: 5.5rem; }
      .lineup-slot-minutes input { min-width: 0; padding: 0 .5rem; }
    `;
    expect(unconstrainedFields(halfFixed)).toEqual(['.lineup-slot-minutes']);
  });

  it('catches a NEW fixed-width field added later without the constraint', () => {
    const regression = `${css}
      .lineup-cue-field { width: 6rem; }
      .lineup-cue-field input { min-height: var(--ss-control-h); }
    `;
    expect(unconstrainedFields(regression)).toEqual(['.lineup-cue-field']);
  });

  it('passes a correctly constrained field, so the check is not simply always-fail', () => {
    const correct = `
      .lineup-slot-minutes { width: 5.5rem; }
      .lineup-slot-minutes input { width: 100%; min-width: 0; padding: 0 .5rem; }
    `;
    expect(unconstrainedFields(correct)).toEqual([]);
  });

  it('does not fire on a fixed-width box that holds no input', () => {
    const innocent = `
      .lineup-slot-handle { width: 3rem; }
      .lineup-drawer-note { width: 8rem; }
    `;
    expect(unconstrainedFields(innocent)).toEqual([]);
  });

  it('does not fire on a fluid label, which has no automatic-minimum problem', () => {
    const fluid = `
      .lineup-slot-notes { width: 100%; }
      .lineup-slot-notes input { padding: 0 .5rem; }
    `;
    expect(unconstrainedFields(fluid)).toEqual([]);
  });
});

describe('the parser itself, so a silent parse failure cannot read as "clean"', () => {
  it('reads selectors and declarations, and ignores comments', () => {
    const rules = parseRules('/* .fake { width: 1rem } */ .a, .b { width: 2rem; min-width: 0 }');
    expect(rules).toEqual([{ selectors: ['.a', '.b'], decls: { width: '2rem', 'min-width': '0' } }]);
  });

  it('recognises fixed lengths and rejects fluid ones', () => {
    expect(['5.5rem', '7rem', '120px', '20ch'].every(isFixedLength)).toBe(true);
    expect(['100%', 'auto', 'min-content', 'var(--w)'].some(isFixedLength)).toBe(false);
  });

  it('actually parsed the real stylesheet rather than yielding nothing', () => {
    expect(parseRules(css).length).toBeGreaterThan(20);
  });
});
