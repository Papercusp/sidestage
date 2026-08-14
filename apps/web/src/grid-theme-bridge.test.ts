import { describe, expect, it } from 'vitest';
import { ROLE_SOURCES, buildGridPalette, normalizeToHex } from './grid-theme-bridge';

/**
 * The bridge exists to stop papergrid painting its neutral DARK default (#0e0e0e header,
 * #e6e6e6 text) on the R3 cream ground. These pin the parts that are decidable without a
 * browser: hex normalisation, the token map, and the omit-rather-than-guess rule.
 *
 * The half that genuinely needs a browser — whether `var()` / `color-mix()` resolve to the
 * expected colour — is verified against live Chromium during the P-004 visual QA pass, not
 * here. jsdom does not implement color-mix() at all, so asserting it against a DOM shim would
 * prove the shim's behaviour and nothing about the app.
 */

describe('normalizeToHex', () => {
  it('converts the rgb() form getComputedStyle returns', () => {
    expect(normalizeToHex('rgb(214, 43, 31)')).toBe('#d62b1f');
  });

  it('converts the space-separated form with an alpha channel, dropping alpha', () => {
    // papergrid concatenates an alpha suffix itself (`${editBorder}55`), so a value carrying
    // its own alpha would produce a 10-digit string that is not a valid colour.
    expect(normalizeToHex('rgb(214 43 31 / 0.5)')).toBe('#d62b1f');
  });

  it('scales CSS Color 4 srgb channels instead of rounding a light mix to black', () => {
    // Chromium serializes the selected-row color-mix in this normalized form.
    // The old generic number parser turned every channel into 0 or 1.
    expect(normalizeToHex('color(srgb 0.976471 0.92549 0.909804)')).toBe('#f9ece8');
    expect(normalizeToHex('color(srgb 1.2 -0.1 0.5 / 0.3)')).toBe('#ff0080');
  });

  it('passes an already-hex value through, lowercased, and expands the 3-digit form', () => {
    expect(normalizeToHex('#D62B1F')).toBe('#d62b1f');
    expect(normalizeToHex('#FFF')).toBe('#ffffff');
  });

  it('clamps and rounds out-of-range channels rather than emitting a malformed hex', () => {
    expect(normalizeToHex('rgb(-5, 255.6, 300)')).toBe('#00ffff');
  });

  it('returns null for something that is not a colour', () => {
    expect(normalizeToHex('')).toBeNull();
    expect(normalizeToHex('definitely-not-a-color')).toBeNull();
  });

  it('always yields a value papergrid can concatenate an alpha suffix onto', () => {
    // The real failure mode this guards: grid-theme.ts builds `1px solid ${editBorder}55`.
    // A raw `var(--brand-red)` or an `rgb(...)` string there produces invalid CSS.
    for (const input of [
      'rgb(214, 43, 31)',
      '#D62B1F',
      'rgb(255 196 0 / 1)',
      'color(srgb 0.97 0.91 0.89)',
    ]) {
      expect(normalizeToHex(input)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe('ROLE_SOURCES', () => {
  it('sources every role from a token, never a literal colour', () => {
    // This is the D-002 property: styles.css :root stays the single source of colour. A hex
    // appearing here would be a second, silently-drifting copy of the palette.
    for (const [role, expression] of Object.entries(ROLE_SOURCES)) {
      expect(expression, `${role} must reference a token`).toMatch(/var\(--/);
      expect(expression, `${role} must not hardcode a hex`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it('covers the roles that made the grid unreadable on the light ground', () => {
    // headerBg was the black bar; text/muted were the near-white cell type; bg/border framed it.
    for (const role of ['headerBg', 'text', 'muted', 'bg', 'border'] as const) {
      expect(ROLE_SOURCES[role]).toBeTruthy();
    }
  });

  it('points the header at a light surface token, not the page ground or a dark one', () => {
    expect(ROLE_SOURCES.headerBg).toBe('var(--surface-sunken)');
  });
});

describe('buildGridPalette', () => {
  it('maps each role through the injected resolver', () => {
    const seen: string[] = [];
    const palette = buildGridPalette((expression) => {
      seen.push(expression);
      return '#abcdef';
    });

    expect(seen).toEqual(Object.values(ROLE_SOURCES));
    expect(Object.keys(palette).sort()).toEqual(Object.keys(ROLE_SOURCES).sort());
    expect(palette.headerBg).toBe('#abcdef');
  });

  it('OMITS a role the resolver cannot resolve, so papergrid keeps its own default', () => {
    // Emitting null/undefined into GRID_COLORS would paint `border: 1px solid undefined55`.
    const palette = buildGridPalette((expression) =>
      expression === ROLE_SOURCES.headerBg ? null : '#ffffff',
    );
    expect('headerBg' in palette).toBe(false);
    expect(palette.text).toBe('#ffffff');
  });

  it('produces an empty patch when nothing resolves, rather than a half-broken palette', () => {
    expect(buildGridPalette(() => null)).toEqual({});
  });
});
