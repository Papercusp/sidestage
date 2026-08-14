import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { VideoChatOverlay } from './VideoChatOverlay';

describe('VideoChatOverlay', () => {
  it('connects its toggle to always-mounted chat content', () => {
    const markup = renderToStaticMarkup(<VideoChatOverlay><p>Subscribed chat</p></VideoChatOverlay>);
    const controls = markup.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(markup).toContain(`id="${controls}"`);
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('Subscribed chat');
  });

  it('collapses accessibly without unmounting its children', () => {
    const markup = renderToStaticMarkup(<VideoChatOverlay open={false}><p>Subscribed chat</p></VideoChatOverlay>);
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('hidden=""');
    expect(markup).toContain('Subscribed chat');
  });
});

