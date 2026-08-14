/**
 * Feeds the R3 "Ticket" palette into papergrid.
 *
 * papergrid is deliberately brand-agnostic: it ships a NEUTRAL DARK default palette and exposes
 * `configureGridColors()` for the host to inject its own (see grid-core/src/grid-theme.ts).
 * SideStage had never called that seam, so every RichGrid rendered the library default — a
 * #0e0e0e header bar and #e6e6e6 body text — which was merely inconsistent on the old dark theme
 * but is unreadable on the R3 cream ground: a black strip across the page with near-white product
 * titles under it. This fixes that at the seam the library provides, rather than forking grid
 * styles into the app.
 *
 * WHY IT READS THE LIVE STYLESHEET INSTEAD OF LISTING HEXES. D-002 makes styles.css `:root` the
 * single source of colour. Re-typing the palette here would fork it, and the two copies would
 * drift the first time a token is retuned. So the bridge RESOLVES tokens out of the live document.
 *
 * WHY IT RESOLVES TO CONCRETE HEX RATHER THAN PASSING `var(--x)` THROUGH. Most of papergrid's
 * consumers are inline styles, where a var() reference would resolve fine — but not all are.
 * `grid-theme.ts` builds `border: 1px solid ${GRID_COLORS.editBorder}55`, concatenating an 8-digit
 * hex alpha onto the value, and the canvas sibling (DataGridShell / glide-data-grid) paints to a
 * 2D context that cannot see CSS custom properties at all. Both need a real colour.
 *
 * STRUCTURE. The colour ENGINE is the browser's — `color-mix()` and custom-property inheritance
 * have exactly one correct evaluator and it is not worth reimplementing. So the browser-dependent
 * step is isolated in `resolveCssColor`, and everything around it (hex normalisation, the role
 * map, palette assembly) is pure and injectable — which is what `buildGridPalette` takes a
 * resolver for. That split is deliberate: it keeps the mapping unit-testable in Node, and keeps
 * the parts that genuinely need a browser out of a DOM shim that would only prove the shim's
 * behaviour. jsdom in particular does not implement `color-mix()`, so asserting real colour
 * resolution against it would be a vacuous test; that half is verified against live Chromium.
 */
import { configureGridColors, type GridColors } from '@papercusp/grid-core';

/**
 * Normalise the concrete forms Chromium returns for computed colours to
 * `#rrggbb`. CSS Color 4 may serialize a `color-mix()` as
 * `color(srgb 0.97 0.91 0.89)`: those channels are normalized to 0–1 and
 * must be scaled to 0–255. Treating them like `rgb()` channels rounds a light
 * selection fill to `#010101`, which is effectively black (WI-38882).
 */
export function normalizeToHex(computed: string): string | null {
  if (!computed) return null;
  const trimmed = computed.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
    const [r, g, b] = trimmed.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const numericChannels = (body: string): number[] =>
    [...body.matchAll(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi)]
      .map((match) => Number(match[0]));
  const rgb = trimmed.match(/^rgba?\((.*)\)$/i);
  const srgb = trimmed.match(/^color\(srgb\s+(.+)\)$/i);
  const channels = rgb ? numericChannels(rgb[1]) : srgb ? numericChannels(srgb[1]) : [];
  if (channels.length < 3) return null;
  const scale = srgb ? 255 : 1;
  return `#${channels.slice(0, 3).map((channel) =>
    Math.max(0, Math.min(255, Math.round(channel * scale))).toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Resolves a CSS colour expression against the live document. The browser-dependent step. */
export type ColorResolver = (expression: string) => string | null;

/**
 * Resolve any CSS colour expression — `var()`, `color-mix()`, a bare hex — to `#rrggbb`, by
 * asking the engine: set it on a detached element and read back what it computed.
 */
export function resolveCssColor(expression: string, root: HTMLElement = document.documentElement): string | null {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.color = expression;
  // An expression the engine rejects leaves style.color empty — bail before touching layout.
  if (!probe.style.color) return null;
  root.appendChild(probe);
  const computed = getComputedStyle(probe).color;
  probe.remove();
  return normalizeToHex(computed);
}

/**
 * Token (or expression) per grid colour role — the whole mapping, in one readable place.
 * Every value is a token reference, never a literal: that is the property the test pins.
 */
export const ROLE_SOURCES: Readonly<Partial<Record<keyof GridColors, string>>> = {
  // Rows sit on white so the grid reads as a card, with the cream ground as the zebra stripe.
  bg: 'var(--surface)',
  rowAlt: 'var(--bg)',
  headerBg: 'var(--surface-sunken)',
  rowHover: 'color-mix(in srgb, var(--brand-red) 9%, var(--surface))',
  border: 'var(--border)',
  text: 'var(--text)',
  muted: 'var(--muted)',
  editBg: 'color-mix(in srgb, var(--brand-red) 7%, var(--surface))',
  editBorder: 'var(--brand-red)',
  amber: 'var(--brand-yellow)',
  red: 'var(--danger)',
  green: 'var(--success)',
  // papergrid uses `blue` only for link text. This palette has no blue, so links take the
  // AA-on-cream brand red rather than importing a stray hue.
  blue: 'var(--red-text)',
};

/**
 * Build the palette patch. A role whose token does not resolve is OMITTED rather than guessed,
 * so papergrid keeps its own default for it instead of receiving a broken value.
 */
export function buildGridPalette(resolve: ColorResolver = (expr) => resolveCssColor(expr)): Partial<GridColors> {
  const palette: Partial<GridColors> = {};
  for (const [role, expression] of Object.entries(ROLE_SOURCES) as [keyof GridColors, string][]) {
    const resolved = resolve(expression);
    if (resolved) palette[role] = resolved;
  }
  return palette;
}

/**
 * Call once at boot, BEFORE the first render: `configureGridColors` rebuilds papergrid's derived
 * style objects and bumps its theme version, so configuring first avoids a flash of the dark
 * default on the initial paint.
 */
export function applyGridTheme(): void {
  if (typeof document === 'undefined') return;
  configureGridColors(buildGridPalette());
}
