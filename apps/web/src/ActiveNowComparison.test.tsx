import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ACTIVE_NOW_COMPARISON_PATH,
  ActiveNowComparison,
  isActiveNowComparisonPath,
} from './ActiveNowComparison';

const comparisonCss = readFileSync(new URL('./active-now-comparison.css', import.meta.url), 'utf8');

describe('ActiveNowComparison', () => {
  it('owns a stable isolated URL without capturing unrelated routes', () => {
    expect(ACTIVE_NOW_COMPARISON_PATH).toBe('/design/channel-guide-active-now');
    expect(isActiveNowComparisonPath('/design/channel-guide-active-now')).toBe(true);
    expect(isActiveNowComparisonPath('/design/channel-guide-active-now/')).toBe(true);
    expect(isActiveNowComparisonPath('/')).toBe(false);
    expect(isActiveNowComparisonPath('/?tab=buyer')).toBe(false);
  });

  it('renders all three treatments side by side with one recommendation', () => {
    const markup = renderToStaticMarkup(<ActiveNowComparison />);

    expect(markup.match(/data-active-now-option=/g)).toHaveLength(3);
    expect(markup).toContain('Signal rail');
    expect(markup).toContain('Spotlight wash');
    expect(markup).toContain('Thumbnail flag');
    expect(markup.match(/Recommended/g)).toHaveLength(1);
  });

  it('keeps content constant so only the visual treatment changes', () => {
    const markup = renderToStaticMarkup(<ActiveNowComparison />);

    expect(markup.match(/Vinyl After Dark/g)).toHaveLength(6);
    expect(markup.match(/Needle &amp; Groove/g)).toHaveLength(6);
    expect(markup.match(/128 watching/g)).toHaveLength(6);
    expect(markup.match(/Studio Ceramics/g)).toHaveLength(6);
    expect(markup.match(/Starts in 14m 32s/g)).toHaveLength(3);
    expect(markup.match(/href="\/\?tab=buyer&amp;event=vinyl-after-dark"/g)).toHaveLength(3);
    expect(markup).not.toContain('amp;amp');
  });

  it('states live, current-watching, and scheduled semantics independently', () => {
    const markup = renderToStaticMarkup(<ActiveNowComparison />);

    expect(markup).toContain('Event is live');
    expect(markup).toContain('Current room');
    expect(markup).toContain('Scheduled countdown');
    expect(markup.match(/aria-label="Vinyl After Dark[^\"]+Currently watching\."/g)).toHaveLength(3);
    expect(markup.match(/class="active-now-sr-only">Currently watching/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="Preview state key"');
  });

  it('uses existing theme tokens and disables decorative motion when requested', () => {
    expect(comparisonCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(comparisonCss).toContain('var(--brand-red)');
    expect(comparisonCss).toContain('var(--brand-yellow)');
    expect(comparisonCss).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(comparisonCss).toMatch(/\.active-now-live-dot\s*\{\s*animation:\s*none/);
  });
});
