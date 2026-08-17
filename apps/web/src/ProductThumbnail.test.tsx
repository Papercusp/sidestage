import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ProductThumbnail } from './ProductThumbnail';

/**
 * WI-39296 — a catalog row carried a supplier URL that 404s
 * (m.media-amazon.com/images/I/714H40QPVHL.jpg on SKU 27ZTPSLARFSX-NEW-0D,
 * still 404 when this was written), and every product-image site rendered it
 * as a bare `<img>`: broken image plus a console error.
 *
 * SCOPE OF THIS FILE, stated because it is a real limit and not an oversight:
 * this project runs `environment: 'node'` with no DOM and no
 * @testing-library/react, so React effects and DOM events do not run here.
 * That means the ONERROR PATH — the actual fix — CANNOT be asserted in this
 * suite. What is covered here is the part SSR can see: the no-URL fallback and
 * the shape of the rendered element. The load-failure path is verified in a
 * real browser instead (see the work-item's completion evidence).
 *
 * Writing a unit test that *looked* like it covered the failure path would be
 * worse than this note: on WI-39292 a test asserting a CSS rule existed passed
 * while the rule was inert, and that is exactly the shape to avoid repeating.
 */
describe('ProductThumbnail (WI-39296)', () => {
  it('renders the placeholder, not an <img>, when there is no URL', () => {
    for (const url of [undefined, null, '', '   ']) {
      const markup = renderToStaticMarkup(<ProductThumbnail url={url} title="Widget" />);
      expect(markup, `url=${JSON.stringify(url)}`).not.toContain('<img');
      expect(markup).toContain('aria-hidden="true"');
    }
  });

  it('derives the placeholder glyph from the title, with a fallback', () => {
    expect(renderToStaticMarkup(<ProductThumbnail title="cdi cable" />)).toContain('C');
    // No title and no URL still renders something rather than an empty box.
    expect(renderToStaticMarkup(<ProductThumbnail />)).toContain('◇');
  });

  it('renders an image for a usable URL, decorative and lazy', () => {
    const markup = renderToStaticMarkup(
      <ProductThumbnail url="https://example.test/a.jpg" title="Widget" />,
    );
    expect(markup).toContain('src="https://example.test/a.jpg"');
    // alt="" is deliberate: the product title is rendered as adjacent text at
    // every call site, so a non-empty alt would announce it twice.
    expect(markup).toContain('alt=""');
    expect(markup).toContain('loading="lazy"');
  });

  it('trims a padded URL rather than emitting a broken src', () => {
    const markup = renderToStaticMarkup(<ProductThumbnail url="  https://example.test/b.jpg  " />);
    expect(markup).toContain('src="https://example.test/b.jpg"');
  });
});
