import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BuyerTab } from './BuyerTab';

/**
 * The BUYER-side cover for the event thumbnail.
 *
 * The owner's ask for this feature was specifically that an uploaded image is
 * "used as the thumbnail in the event browser" — i.e. the buyer surface is the
 * deliverable, not the seller's upload control. That control is covered by
 * EventCreationPanel.thumbnail.test.tsx and the encode/validate core by
 * thumbnail.test.ts, which left exactly this wiring — BuyerTab -> EventThumbnail
 * -> <img>/poster — asserted nowhere. This file closes that.
 *
 * Rendered with renderToStaticMarkup, matching the hive's convention (there is
 * no DOM environment and no @testing-library/react). Effects do not run under
 * static rendering, so the `thumbnailUrl` PROP is the seam under test here; the
 * fetch-from-config path it falls back to is deliberately out of scope and is
 * called out in the last test below.
 */

const STATS = { viewers: 0, itemsSold: 0, totalRaisedCents: 0 } as const;

function render(thumbnailUrl?: string): string {
  return renderToStaticMarkup(
    <BuyerTab eventId="evt-thumb" eventTitle="Vintage Camera Drop" products={[]} stats={STATS} thumbnailUrl={thumbnailUrl} />,
  );
}

/**
 * Slice out just the buyer's thumbnail box.
 *
 * Asserting over the whole page would be a false claim about a true thing: the
 * product rail renders its own <img> per row, so a page-wide "has an image"
 * or "has no image" assertion passes or fails for reasons unrelated to the
 * thumbnail. Matched on the class TOKEN rather than the full attribute value,
 * because EventThumbnail composes its own class with the one BuyerTab passes.
 */
function thumbnailBox(html: string): string {
  const open = html.search(/<div class="[^"]*\bbuyer-event-thumbnail\b/);
  expect(open).toBeGreaterThan(-1);
  const close = html.indexOf('</div>', open);
  return html.slice(open, close + '</div>'.length);
}

describe('BuyerTab event thumbnail', () => {
  const PNG = 'data:image/png;base64,iVBORw0KGgo=';

  it('renders the stored thumbnail as the buyer-facing image', () => {
    const box = thumbnailBox(render(PNG));
    expect(box).toContain(`src="${PNG}"`);
  });

  it('names the event in the alt text instead of leaving it unlabelled', () => {
    const box = thumbnailBox(render(PNG));
    // The alt text is the only description a screen-reader user gets for the
    // event's image, so it must carry the event name, not a generic string.
    expect(box).toContain('alt="Vintage Camera Drop thumbnail"');
  });

  it('falls back to the placeholder when the event has no thumbnail', () => {
    const box = thumbnailBox(render(undefined));
    expect(box).toContain('event-thumbnail-empty');
    expect(box).not.toContain('<img');
  });

  // The security-relevant case: a stored value can predate a tightening of the
  // allow-list, or arrive from a fixture that never went through the API's
  // validation at all. The buyer render must refuse it rather than trust that
  // the write path was the only way in.
  for (const hostile of [
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:image/svg+xml;base64,PHN2Zy8+',
  ]) {
    it(`refuses to render a hostile thumbnail value (${hostile.slice(0, 24)}...)`, () => {
      const html = render(hostile);
      // It falls back...
      expect(thumbnailBox(html)).toContain('event-thumbnail-empty');
      // ...and, the claim that actually matters, the hostile string reaches NO
      // attribute anywhere on the buyer page — not the <img src>, and not the
      // <video poster>, which consumes the same value on a separate code path.
      expect(html).not.toContain(hostile);
    });
  }

  it('does not render a thumbnail image before the config fetch has resolved', () => {
    // Effects do not run under static rendering, so this is the first-paint
    // state of an event whose thumbnail is only known from the API. Asserting
    // it pins the fallback as the INITIAL state: without it, a regression that
    // renders a broken <img> until the fetch lands would go unnoticed here.
    const box = thumbnailBox(render(undefined));
    expect(box).not.toContain('<img');
  });
});
