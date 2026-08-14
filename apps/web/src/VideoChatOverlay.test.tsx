import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { scrollVideoChatToLatest, VideoChatOverlay } from './VideoChatOverlay';

const overlayCss = readFileSync(new URL('./video-chat-overlay.css', import.meta.url), 'utf8');

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

  it('moves an explicit chat scroll target to its latest row when opened', () => {
    const messages = { scrollHeight: 640, scrollTop: 0 };
    const root = {
      querySelector: (selector: string) => selector === '[data-video-chat-scroll]' ? messages : null,
    } as unknown as ParentNode;

    scrollVideoChatToLatest(root);

    expect(messages.scrollTop).toBe(640);
  });

  it('anchors the audience chat lower-left without restoring an opaque card', () => {
    expect(overlayCss).toMatch(/\.video-chat-overlay\s*\{[^}]*bottom:\s*\.75rem;[^}]*left:\s*\.75rem;/s);
    expect(overlayCss).toMatch(/\.video-chat-overlay-content\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;[^}]*backdrop-filter:\s*none;/s);
    expect(overlayCss).toMatch(/\.event-chat-audience-messages\s*\{[^}]*align-content:\s*safe end;[^}]*background:\s*linear-gradient[^}]*pointer-events:\s*auto;/s);
    expect(overlayCss).toMatch(/\.event-chat-audience-message\s*\{[^}]*background:\s*transparent;[^}]*pointer-events:\s*none;/s);
    expect(overlayCss).toMatch(/\.event-chat-audience-form\s*\{[^}]*border-radius:\s*999px;[^}]*backdrop-filter:\s*blur\(6px\);[^}]*pointer-events:\s*auto;/s);
    expect(overlayCss).not.toContain('.video-chat-overlay-content > .event-chat-card');
  });
});
