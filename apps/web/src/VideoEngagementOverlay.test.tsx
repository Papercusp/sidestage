import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  remoteTranscriptPresentation,
  scrollVideoEngagementChatToLatest,
  VideoEngagementOverlay,
} from './VideoEngagementOverlay';

describe('VideoEngagementOverlay', () => {
  it('keeps chat and transcript in one video-owned surface', () => {
    const transcript = remoteTranscriptPresentation([{
      id: 'moment-1',
      text: 'The glaze is food safe.',
      startMs: 12_000,
      productId: 'mug',
      productTitle: 'Stoneware mug',
    }]);
    const markup = renderToStaticMarkup(
      <VideoEngagementOverlay chat={<p>Room message</p>} transcript={transcript} />,
    );

    const controls = markup.match(/class="video-engagement-chat-toggle" aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(markup).toContain('class="video-engagement-overlay"');
    expect(markup).toContain(`id="${controls}"`);
    expect(markup).toContain('Room message');
    expect(markup).toContain('The glaze is food safe.');
    expect(markup).toContain('Transcript live');
    expect(markup).toContain('On stage: <strong>Stoneware mug</strong>');
  });

  it('keeps collapsed chat mounted and reports an unavailable empty transcript', () => {
    const markup = renderToStaticMarkup(
      <VideoEngagementOverlay
        chat={<p>Subscribed chat</p>}
        transcript={remoteTranscriptPresentation([], new Error('offline'))}
        chatOpen={false}
      />,
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('hidden=""');
    expect(markup).toContain('Subscribed chat');
    expect(markup).toContain('Transcript unavailable');
    expect(markup).toContain('The live transcript is temporarily unavailable.');
  });

  it('scrolls an explicit chat target to its latest row', () => {
    const messages = { scrollHeight: 640, scrollTop: 0 };
    const root = {
      querySelector: (selector: string) => selector === '[data-video-chat-scroll]' ? messages : null,
    } as unknown as ParentNode;

    scrollVideoEngagementChatToLatest(root);

    expect(messages.scrollTop).toBe(640);
  });
});
