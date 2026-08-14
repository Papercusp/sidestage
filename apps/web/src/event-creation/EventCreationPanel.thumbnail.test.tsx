import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EventCreationPanel } from './EventCreationPanel';
import { ALLOWED_THUMBNAIL_TYPES } from './thumbnail';
import type { CatalogRow } from './catalog';

/**
 * Markup-level cover for the thumbnail control.
 *
 * This hive renders components with renderToStaticMarkup (see
 * InventoryPickerGrid.test.tsx) — there is no @testing-library/react and no DOM
 * environment, so the PICK interaction itself is not reachable from a test here.
 * That is covered where the behaviour actually lives: thumbnail.test.ts unit-tests
 * validateThumbnailFile/readThumbnailFile (the whole accept/reject/encode core)
 * against a ThumbnailFileLike, which is exactly why that module takes a
 * structural file type instead of a DOM File. What is left to assert here is the
 * markup contract the panel is responsible for.
 */

const ROWS: CatalogRow[] = [
  {
    id: 'espresso-new',
    groupId: 'espresso',
    title: 'Barista Pro Espresso Machine',
    brand: 'BrewHaus',
    productType: 'KITCHEN_APPLIANCE',
    sku: 'BH-ESP-200-NEW',
    condition: 'NEW',
    handlingDays: 2,
    priceCents: 49_999,
    availableQty: 12,
  },
];

function render(): string {
  return renderToStaticMarkup(<EventCreationPanel catalog={ROWS} />);
}

/**
 * Slice out just the thumbnail preview box.
 *
 * Asserting "no <img> anywhere in the panel" would be a FALSE claim about a
 * true thing: the catalog grid renders a product image per row, so that
 * assertion fails for a reason unrelated to the thumbnail. Scope the claim to
 * the element it is actually about.
 */
function previewBox(html: string): string {
  // Matched on the class TOKEN, not a full class string: the preview is
  // rendered by EventThumbnail, which composes its own class with the one the
  // panel passes, so pinning the exact attribute value would re-break on any
  // future class added there.
  const open = html.search(/<div class="[^"]*\bevent-thumbnail-preview\b/);
  expect(open).toBeGreaterThan(-1);
  const close = html.indexOf('</div>', open);
  return html.slice(open, close + '</div>'.length);
}

describe('EventCreationPanel thumbnail control', () => {
  it('offers a file input restricted to the accepted image types', () => {
    const html = render();
    expect(html).toContain('type="file"');
    expect(html).toContain(`accept="${ALLOWED_THUMBNAIL_TYPES.join(',')}"`);
    // The accept attribute is a convenience filter, never the check — the real
    // gate is validateThumbnailFile, and the API re-validates independently.
    expect(ALLOWED_THUMBNAIL_TYPES).not.toContain('image/svg+xml');
  });

  it('labels the control and states the limits so the seller reads them before picking', () => {
    const html = render();
    expect(html).toContain('Event thumbnail');
    expect(html).toContain('Upload image');
    expect(html).toContain('JPEG, PNG, WebP, or GIF');
    expect(html).toContain('512KB');
  });

  it('starts with the placeholder and no image, and offers no Remove until one is picked', () => {
    const html = render();
    const preview = previewBox(html);
    expect(preview).toContain('event-thumbnail-placeholder');
    expect(preview).not.toContain('<img');
    // The empty preview is decorative, so it is hidden from assistive tech —
    // the label and status text already say there is no thumbnail yet.
    expect(preview).toContain('aria-hidden="true"');
    expect(html).not.toContain('>Remove<');
  });

  it('associates the file input with its visible label for assistive tech', () => {
    const html = render();
    expect(html).toContain('id="event-thumbnail-label"');
    expect(html).toContain('aria-labelledby="event-thumbnail-label"');
  });
});
