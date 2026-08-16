import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  nextTranscriptErrorState,
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

  it('keeps an empty transcript in its loading state while the principal-scoped query rebinds', () => {
    const transcript = remoteTranscriptPresentation([], new Error('stale principal error'), true);

    expect(transcript).toMatchObject({
      state: 'idle',
      error: null,
      statusLabel: 'Waiting for captions',
    });
  });

  it('renders a transcript-only surface without empty chat controls', () => {
    const markup = renderToStaticMarkup(
      <VideoEngagementOverlay
        transcript={remoteTranscriptPresentation([{
          id: 'moment-2',
          text: 'This jacket is the current item.',
          startMs: 24_000,
        }])}
      />,
    );

    expect(markup).toContain('This jacket is the current item.');
    expect(markup).not.toContain('video-engagement-chat-panel');
    expect(markup).not.toContain('video-engagement-chat-toggle');
  });

  it('forgives a single transient transcript-poll failure (EI-20538641531453022)', () => {
    // Healthy start.
    let state = nextTranscriptErrorState(0, null);
    expect(state).toEqual({ streak: 0, confirmed: null });

    // One failed poll: not yet confirmed — a single blip shouldn't alarm the buyer.
    state = nextTranscriptErrorState(state.streak, new Error('transient'));
    expect(state.streak).toBe(1);
    expect(state.confirmed).toBeNull();

    // Recovers on the very next poll: streak resets, still no alert.
    state = nextTranscriptErrorState(state.streak, null);
    expect(state).toEqual({ streak: 0, confirmed: null });
  });

  it('confirms a sustained transcript-poll failure across two consecutive polls', () => {
    let state = nextTranscriptErrorState(0, new Error('offline'));
    expect(state.confirmed).toBeNull();
    state = nextTranscriptErrorState(state.streak, new Error('offline'));
    expect(state.streak).toBe(2);
    expect(state.confirmed).toBeInstanceOf(Error);
    expect(state.confirmed?.message).toBe('offline');
  });

  it('wraps a non-Error rejection into an Error for the confirmed state', () => {
    let state = nextTranscriptErrorState(0, 'boom');
    state = nextTranscriptErrorState(state.streak, 'boom');
    expect(state.confirmed).toBeInstanceOf(Error);
    expect(state.confirmed?.message).toBe('boom');
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
