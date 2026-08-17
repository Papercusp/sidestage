import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { STUDIO_MOBILE_MEDIA_QUERY } from './SellerMobileStudio';

/**
 * WI-39287 regression guard.
 *
 * The Active Event dock clipped its Run of show / Inventory tab strip in the
 * 761-768px band because TWO things fired at the same 761px breakpoint:
 *
 *   1. the Seller tab swapped from SellerMobileStudio to the desktop Dockview
 *      (STUDIO_MOBILE_MEDIA_QUERY, `(max-width: 760px)`), and
 *   2. the 2-column shell restored the channel guide, whose width floor is
 *      16rem -- so at 768px the guide took 256px and left the dock 512px.
 *
 * The default board's natural width is 620 + 380 = 1000px and
 * `.seller-dock-host` is `overflow: hidden`, so the surplus was cut off rather
 * than scrolled: dockview sizes its groups wider than the host, so its own
 * `.dv-tabs-container { overflow: auto }` has nothing of its own to scroll.
 *
 * These assertions read the CSS SOURCE (the convention used by
 * BuyerTab.products.test.tsx) because jsdom performs no layout and therefore
 * cannot observe the clip itself.
 */

const studioCss = readFileSync(new URL('./studio.css', import.meta.url), 'utf8');
const sharedCss = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

/** The narrowest viewport at which the desktop Dockview mounts. */
const DESKTOP_DOCK_MIN_VIEWPORT = 761;
/** The tablet viewport named in the defect report (768x1024). */
const REPORTED_TABLET_VIEWPORT = 768;

/** Extract a `@media (max-width: Npx)` block body, brace-matched. */
function mediaBlock(css: string, maxWidthPx: number): string | undefined {
  const header = `@media (max-width: ${maxWidthPx}px)`;
  const headerAt = css.indexOf(header);
  if (headerAt === -1) return undefined;
  const open = css.indexOf('{', headerAt);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return undefined;
}

/** Every `max-width` bound that collapses the seller shell's channel guide. */
function sellerGuideCollapseBounds(css: string): number[] {
  const bounds: number[] = [];
  const header = /@media \(max-width: (\d+)px\)/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(css)) !== null) {
    const bound = Number(match[1]);
    const body = mediaBlock(css, bound);
    if (!body) continue;
    if (
      /\.app-shell(?:\.app-shell)?--seller\s*\{[^}]*--channel-guide-width:\s*0px;/s.test(body)
    ) {
      bounds.push(bound);
    }
  }
  return bounds;
}

describe('WI-39287: seller dock tablet breakpoint', () => {
  it('collapses the seller channel guide across the whole band where the desktop dock mounts', () => {
    const bounds = sellerGuideCollapseBounds(studioCss);
    expect(bounds.length).toBeGreaterThan(0);

    // The widest collapse bound must cover the reported 768px tablet viewport;
    // otherwise the guide reclaims 256px from a dock that has no room for it.
    const widest = Math.max(...bounds);
    expect(widest).toBeGreaterThanOrEqual(REPORTED_TABLET_VIEWPORT);
    expect(widest).toBeGreaterThanOrEqual(DESKTOP_DOCK_MIN_VIEWPORT);
  });

  it('does not move the 760px component swap while fixing the guide', () => {
    // The fix must decouple the guide from the dock swap, NOT relocate the swap:
    // moving this would change which surface mounts on a phone.
    expect(STUDIO_MOBILE_MEDIA_QUERY).toBe('(max-width: 760px)');
  });

  it('keeps the guide-collapse bound strictly wider than the mobile-studio bound', () => {
    // The defect WAS the two bounds being equal (both 760): the guide returned on
    // the same pixel the desktop dock appeared. They must not re-converge.
    const bounds = sellerGuideCollapseBounds(studioCss);
    expect(Math.max(...bounds)).toBeGreaterThan(760);
  });

  it('still floors the channel guide at 16rem, which is why 768px could not afford it', () => {
    // Documents the arithmetic the fix depends on: at 768px, 24vw = 184px, but the
    // 16rem (256px) floor wins -- so a restored guide leaves only 512px of dock.
    expect(sharedCss).toMatch(
      /\.app-shell\s*\{[^}]*--channel-guide-width:\s*clamp\(16rem,\s*24vw,\s*19rem\);/s,
    );
  });

  it('keeps the dock host clipping, so an oversized board is cut rather than scrolled', () => {
    // Not a bug in itself, but it is why the overflow was unreachable: with the
    // host hidden and dockview sizing groups wider than it, no scrollbar appears.
    const dockCss = readFileSync(new URL('./seller-dock.css', import.meta.url), 'utf8');
    expect(dockCss).toMatch(/\.seller-dock-host\s*\{[^}]*overflow:\s*hidden;/s);
  });
});
