import { isRenderableThumbnailUrl } from './thumbnail';
// The component carries its own styles: it renders on buyer surfaces that do
// not import the event-creation stylesheet, and a thumbnail with no CSS is an
// unsized full-width image. Vite dedupes the import where both are present.
import './event-creation.css';

export interface EventThumbnailProps {
  /** The stored thumbnail URL, or nothing when the event has none. */
  url?: string | null;
  /** Event name, used to write the alt text. */
  eventName?: string;
  /** Extra class on the wrapper so each surface can size it. */
  className?: string;
  /** Persistent guide rails are below-fold/hidden on phones; let them defer image work. */
  loading?: 'eager' | 'lazy';
}

/**
 * The ONE place an event thumbnail is rendered, so every surface shows the same
 * image and the same fallback.
 *
 * The renderability check is repeated HERE rather than trusted from the API,
 * because this is the component that owns the `<img src>`. A stored value can
 * predate a tightening of the allow-list, or arrive from a fixture or a test
 * that never went through the API at all — so the render path re-checks instead
 * of assuming the write path was the only way in. An unrenderable value falls
 * back to the placeholder rather than emitting a broken or unsafe `src`.
 */
export function EventThumbnail({ url, eventName, className, loading = 'eager' }: EventThumbnailProps) {
  const renderable = isRenderableThumbnailUrl(url);
  const classes = ['event-thumbnail', className].filter(Boolean).join(' ');

  if (!renderable) {
    return (
      <div className={`${classes} event-thumbnail-empty`} aria-hidden="true">
        <span className="event-thumbnail-placeholder">◍</span>
      </div>
    );
  }

  return (
    <div className={classes}>
      <img
        src={url as string}
        alt={eventName ? `${eventName} thumbnail` : 'Event thumbnail'}
        loading={loading}
      />
    </div>
  );
}

export default EventThumbnail;
