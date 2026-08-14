import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SELLER_DOCK_CLASS_NAME } from './SellerDock';

/**
 * P-011 dock-chrome guards.
 *
 * These pin the two failure modes the retheme pass actually found, both of
 * which are INVISIBLE to a typechecker, a renderer, and a unit test of the
 * components themselves — because in CSS an unknown custom property is not an
 * error, it is simply nothing:
 *
 *   1. A `--dv-*` name dockview does not read is inert. `--dv-tabs-container-height`
 *      sat in seller-dock.css looking entirely correct while doing nothing at
 *      all; the variable dockview applies is `--dv-tabs-and-actions-container-height`.
 *
 *   2. dockview defines its variables inside its theme CLASSES, not on :root,
 *      and `DockWorkspace` renders `className ?? 'dockview-theme-dark'` — so
 *      passing a className REPLACES the base theme instead of adding to it.
 *      That left 29 of the 47 variables dockview's generic rules consume
 *      resolving to nothing, including the resize-sash colour.
 *
 * FALSIFIABILITY. Every predicate below is a pure function, and each is
 * exercised against BOTH the real subject (which must pass) and a deliberately
 * broken control (which must fail). A guard that has only ever seen a passing
 * input is not evidence — and the controls are permanent fixtures here rather
 * than a mutation of the shared tree, which on this repo can be swept into a
 * commit by git-sync while the probe is still running.
 */

const require_ = createRequire(import.meta.url);
const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * Measured against the REAL dockview stylesheet, resolved through the same
 * specifier the app loads (dock-workbench imports
 * 'dockview-react/dist/styles/dockview.css'). A dockview upgrade that renames
 * or drops a variable therefore fails here, instead of silently un-theming the
 * dock in production.
 */
const dockviewCss = readFileSync(
  require_.resolve('dockview-react/dist/styles/dockview.css'),
  'utf8',
);
const sellerDockCss = readFileSync(`${here}seller-dock.css`, 'utf8');
const rootCss = readFileSync(`${here}styles.css`, 'utf8');

// ---------------------------------------------------------------- predicates

const varsIn = (css: string, re: RegExp) =>
  new Set(Array.from(css.matchAll(re), (m) => m[1]));

/** Custom properties a stylesheet DECLARES (`--x: …`). */
export const declaredVars = (css: string) => varsIn(css, /^\s*(--dv-[a-z0-9-]+)\s*:/gm);

/** Custom properties a stylesheet READS (`var(--x)`). */
const readVars = (css: string) => varsIn(css, /var\((--dv-[a-z0-9-]+)/g);

/** Each `.dockview-theme-*` block's body, keyed by class name. */
const themeBlocks = (css: string) => {
  const out = new Map<string, string>();
  for (const m of css.matchAll(/\.(dockview-theme-[a-z]+)[^{]*\{([^}]*)\}/g)) {
    out.set(m[1], (out.get(m[1]) ?? '') + m[2]);
  }
  return out;
};

/**
 * dockview's rules with every theme block removed.
 *
 * The distinction is the whole point: a theme block both DEFINES variables and
 * consumes its own private palette (`--dv-color-abyss-*`, `--dv-color-gh-*`).
 * Counting those as "consumed" would demand we define palette entries for
 * themes we never use. What a consumer must supply is only what the generic
 * rules read.
 */
const stripThemeBlocks = (css: string) =>
  css.replace(/\.dockview-theme-[a-z]+[^{]*\{[^}]*\}/g, '');

/** Declared names that dockview never reads anywhere — inert, silent no-ops. */
export const inertDeclarations = (declared: Set<string>, known: Set<string>) =>
  [...declared].filter((v) => !known.has(v)).sort();

/** Names dockview reads that nothing in our stack defines — resolve to nothing. */
export const unresolvedVars = (
  consumed: Set<string>,
  definedByBase: Set<string>,
  declared: Set<string>,
) => [...consumed].filter((v) => !definedByBase.has(v) && !declared.has(v)).sort();

/**
 * Colour literals in a stylesheet, comments excluded.
 *
 * retheme D-002: styles.css :root is the single source of colour, and a
 * component needing a colour with no token gets a NEW NAMED TOKEN. The dock
 * stylesheet may reference `var(--…)` freely but must not spell a colour
 * itself. Comments are stripped because the file header discusses hexes.
 */
export const colourLiterals = (css: string) =>
  css.replace(/\/\*[\s\S]*?\*\//g, '').match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(/g) ?? [];

/** Everything wrong with a dock class name, as human-readable reasons. */
export const classNameProblems = (className: string, shippedThemes: Set<string>) => {
  const parts = className.split(/\s+/).filter(Boolean);
  const base = parts.find((c) => c.startsWith('dockview-theme-'));
  const problems: string[] = [];
  if (!base) {
    problems.push('no dockview base theme class — every --dv-* variable is undefined');
  } else if (!shippedThemes.has(base)) {
    problems.push(`base theme ${base} is not one dockview ships`);
  }
  if (!parts.includes('seller-dock-theme')) {
    problems.push('missing the seller-dock-theme token layer');
  } else if (base && parts.indexOf('seller-dock-theme') < parts.indexOf(base)) {
    // Equal specificity (both single-class), so order is the tiebreak.
    problems.push('seller-dock-theme is listed before the base theme and would be shadowed');
  }
  return problems;
};

// ------------------------------------------------------------------ subjects

const blocks = themeBlocks(dockviewCss);
const consumedByDockview = readVars(stripThemeBlocks(dockviewCss));
const declaredBySeller = declaredVars(sellerDockCss);
const knownToDockview = new Set([...consumedByDockview, ...declaredVars(dockviewCss)]);
const baseThemeClass = SELLER_DOCK_CLASS_NAME.split(/\s+/).find((c) =>
  c.startsWith('dockview-theme-'),
) as string;

describe('seller dock class name', () => {
  it('pairs a real dockview base theme with the token layer, in that order', () => {
    expect(classNameProblems(SELLER_DOCK_CLASS_NAME, new Set(blocks.keys()))).toEqual([]);
  });

  it('CONTROL: rejects the three ways the pairing breaks', () => {
    const shipped = new Set(blocks.keys());
    // The exact bug this lane found: token layer alone, base theme replaced.
    expect(classNameProblems('seller-dock-theme', shipped)).toEqual([
      'no dockview base theme class — every --dv-* variable is undefined',
    ]);
    // A theme name that does not exist still leaves everything undefined.
    expect(classNameProblems('dockview-theme-cream seller-dock-theme', shipped)).toEqual([
      'base theme dockview-theme-cream is not one dockview ships',
    ]);
    // Right classes, wrong order: the base theme would win the specificity tie.
    expect(classNameProblems('seller-dock-theme dockview-theme-light', shipped)).toEqual([
      'seller-dock-theme is listed before the base theme and would be shadowed',
    ]);
  });
});

describe('seller dock chrome variables', () => {
  it('declares only variables dockview actually reads', () => {
    expect(
      inertDeclarations(declaredBySeller, knownToDockview),
      'these --dv-* declarations are inert — dockview never reads them, so they ' +
        'silently do nothing (this is how --dv-tabs-container-height hid)',
    ).toEqual([]);
  });

  it('CONTROL: catches the inert name that shipped', () => {
    // The real declaration set plus the historical typo must be flagged, and
    // flagged as exactly that one name — proving the check discriminates
    // rather than failing everything.
    const withTypo = new Set([...declaredBySeller, '--dv-tabs-container-height']);
    expect(inertDeclarations(withTypo, knownToDockview)).toEqual([
      '--dv-tabs-container-height',
    ]);
  });

  it('leaves no variable dockview reads undefined', () => {
    const definedByBase = varsIn(blocks.get(baseThemeClass) ?? '', /(--dv-[a-z0-9-]+)\s*:/g);
    expect(
      unresolvedVars(consumedByDockview, definedByBase, declaredBySeller),
      `dockview reads these but neither ${baseThemeClass} nor seller-dock.css ` +
        'defines them, so they resolve to nothing',
    ).toEqual([]);
  });

  it('CONTROL: dropping the base theme leaves many variables undefined', () => {
    // Recreates the shipped state: token layer only, no base theme. If this
    // ever returns [], the check above has stopped measuring anything and its
    // green is meaningless.
    const undefinedWithoutBase = unresolvedVars(
      consumedByDockview,
      new Set(),
      declaredBySeller,
    );
    expect(undefinedWithoutBase.length).toBeGreaterThan(15);
    // A variable the base theme is the ONLY supplier of — this file
    // deliberately does not declare it, so it is a true positive for
    // "the base theme is load-bearing". (--dv-sash-color would NOT work here:
    // this lane now declares it, which is exactly why it must not be the
    // control — an earlier draft asserted it and the control caught that.)
    expect(undefinedWithoutBase).toContain('--dv-overlay-z-index');
    expect(declaredBySeller).not.toContain('--dv-overlay-z-index');
  });

  it('sets the tab-strip height through the variable dockview applies', () => {
    expect(declaredBySeller).toContain('--dv-tabs-and-actions-container-height');
    expect(dockviewCss).toMatch(/height:\s*var\(--dv-tabs-and-actions-container-height\)/);
  });
});

describe('seller dock chrome colours', () => {
  it('routes every colour through a token, never a literal', () => {
    expect(colourLiterals(sellerDockCss), 'hardcoded colour literal in dock chrome').toEqual(
      [],
    );
  });

  it('CONTROL: colour literals are detected, and comments are not', () => {
    expect(colourLiterals('a{color:#fff}')).toEqual(['#fff']);
    expect(colourLiterals('a{box-shadow:0 1px 2px rgb(0 0 0 / 17%)}')).toEqual(['rgb(']);
    expect(colourLiterals('/* no #hardcoded hexes here */ a{color:var(--text)}')).toEqual([]);
  });

  it('takes its elevation from the shared token', () => {
    // The float shadow was an inline rgb() duplicating .stage-panel's shadow.
    expect(sellerDockCss).toMatch(/--dv-floating-box-shadow:\s*var\(--shadow-float\)/);
    expect(rootCss, '--shadow-float must be defined in the :root token block').toMatch(
      /^\s*--shadow-float\s*:/m,
    );
  });
});

/**
 * P-015 board-resize handles must out-layer dockview's sashes.
 *
 * THE BUG THIS PINS, found by driving the running app: the board's resize
 * handles shipped at z-index 2/3 while dockview's panel splitters
 * (`.dv-split-view-container .dv-sash-container .dv-sash`) sit at 99. dockview
 * runs those sashes out to the board's outer edges, so the east handle's 6px
 * strip was overlapped along its whole height — `elementFromPoint` at the east
 * handle's own CENTRE returned `.dv-sash`, and a pointer drag on the width
 * affordance did nothing at all.
 *
 * It was invisible to every cheaper instrument, which is the reason for a guard
 * rather than a fix alone: the component renders, the typechecker is happy, the
 * store round-trips, and KEYBOARD resizing passes — arrow keys need no
 * hit-test, so the unit suite exercised the identical code path and stayed
 * green while the mouse path was dead.
 *
 * The sash z-index is MEASURED from the real dockview stylesheet, not written
 * as a literal, so a dockview upgrade that raises it fails here instead of
 * silently re-burying the handles.
 */
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * `z-index` of every rule whose SELECTOR matches `re`, in source order.
 *
 * The selector is TRIMMED before matching: the capture runs from the end of the
 * previous rule, so it carries leading newlines and indentation and an anchored
 * pattern (`/^\.foo$/`) would never match the raw text.
 */
export const zIndexesFor = (css: string, re: RegExp): number[] =>
  Array.from(stripComments(css).matchAll(/([^{}]*)\{([^{}]*)\}/g))
    .filter((m) => re.test(m[1].trim()))
    .map((m) => /(?:^|[;\s])z-index\s*:\s*(-?\d+)/.exec(m[2]))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));

const sashZIndexes = zIndexesFor(dockviewCss, /\.dv-sash\b/);
const handleZIndexes = zIndexesFor(sellerDockCss, /\.seller-dock-board-handle/);

describe('seller dock board resize handles', () => {
  it('dockview really does layer its sashes above the default stacking order', () => {
    // If this ever comes back empty the guard below would pass vacuously.
    expect(sashZIndexes.length, 'no .dv-sash z-index found in dockview.css').toBeGreaterThan(0);
  });

  it('layers every board handle ABOVE dockview sashes, or the pointer never reaches them', () => {
    expect(handleZIndexes.length, 'no z-index declared for .seller-dock-board-handle').toBeGreaterThan(0);
    const topSash = Math.max(...sashZIndexes);
    const buried = handleZIndexes.filter((z) => z <= topSash);
    expect(
      buried,
      `board handle z-index ${buried.join(', ')} is at or below dockview's sash (${topSash}); ` +
        'the handle will be unhittable by pointer while keyboard resizing still passes',
    ).toEqual([]);
  });

  it('CONTROL: the shipped 2/3 layering is caught, and the parser reads real rules', () => {
    // The exact values this bug shipped with, against dockview's real 99.
    const topSash = Math.max(...sashZIndexes);
    expect(topSash).toBe(99);
    expect([2, 3].filter((z) => z <= topSash)).toEqual([2, 3]);
    // Parser: selector-matched, comment-immune, and blind to unrelated rules.
    expect(zIndexesFor('.a{z-index:5}.b{z-index:9}', /\.a/)).toEqual([5]);
    expect(zIndexesFor('/* .a{z-index:5} */ .a{z-index:7}', /\.a/)).toEqual([7]);
    expect(zIndexesFor('.a{color:red}', /\.a/)).toEqual([]);
  });

  it('keeps the corner above the edge handles so it still drives both axes', () => {
    const edge = zIndexesFor(sellerDockCss, /^\.seller-dock-board-handle$/);
    const corner = zIndexesFor(sellerDockCss, /\.seller-dock-board-handle--se/);
    expect(edge.length, 'base handle rule must declare a z-index').toBe(1);
    expect(corner.length, 'corner handle must declare its own z-index').toBe(1);
    expect(corner[0]).toBeGreaterThan(edge[0]);
  });
});
