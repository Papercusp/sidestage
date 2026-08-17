import { useState } from 'react';

export interface ProductThumbnailProps {
  /** The stored image URL, or nothing when the product has none. */
  url?: string | null;
  /** Product title — used only to derive the placeholder glyph, never rendered as alt. */
  title?: string;
  className?: string;
}

/**
 * A product thumbnail that degrades to the placeholder when the image cannot be
 * shown — whether because there is no URL, or because the URL is dead.
 *
 * WHY THIS EXISTS (WI-39296). Every product-image site in this app was written
 * as `url ? <img src={url}/> : <placeholder/>`, which handles an ABSENT url and
 * nothing else. A url that is PRESENT and 404s renders a broken image plus a
 * console error, because nothing listens for the failure. That is not
 * hypothetical: catalog rows carry supplier URLs we do not control, and
 * `https://m.media-amazon.com/images/I/714H40QPVHL.jpg` on SKU
 * 27ZTPSLARFSX-NEW-0D has been 404 since at least 2026-08-15 (re-confirmed 404
 * while fixing this). The dead link is DATA and will recur with any supplier;
 * the render path is what has to be resilient.
 *
 * The failure is remembered PER URL rather than as a bare boolean, so a row
 * that re-renders with a different image gets a fresh attempt instead of
 * inheriting the previous URL's failure — a plain `useState(false)` would latch
 * the placeholder onto whatever image came next.
 *
 * `alt=""` is deliberate and matches the existing call sites: the product title
 * is always rendered as adjacent text, so announcing it again from the image
 * would just duplicate it for a screen-reader user.
 */
export function ProductThumbnail({ url, title, className }: ProductThumbnailProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const trimmed = typeof url === 'string' ? url.trim() : '';
  const usable = trimmed.length > 0 && failedUrl !== trimmed;

  if (!usable) {
    return (
      <span className={className} aria-hidden="true">
        {title?.trim()?.charAt(0)?.toUpperCase() || '◇'}
      </span>
    );
  }

  return (
    <img
      className={className}
      src={trimmed}
      alt=""
      loading="lazy"
      onError={() => setFailedUrl(trimmed)}
    />
  );
}

export default ProductThumbnail;
