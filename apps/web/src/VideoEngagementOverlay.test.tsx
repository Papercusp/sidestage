import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { liveTranscriptPresentation, TranscriptOverlayView } from './LiveTranscriptOverlay';
import type { LiveTranscriptController } from './use-live-transcript';
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
    }], { videoLive: true });
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
        transcript={remoteTranscriptPresentation([], { videoLive: false, error: new Error('offline') })}
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
    const transcript = remoteTranscriptPresentation(
      [],
      { videoLive: false, error: new Error('stale principal error'), loading: true },
    );

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
        }], { videoLive: true })}
      />,
    );

    expect(markup).toContain('This jacket is the current item.');
    expect(markup).not.toContain('video-engagement-chat-panel');
    expect(markup).not.toContain('video-engagement-chat-toggle');
  });

  it('never claims "Transcript live" while the buyer has no video (WI-39839)', () => {
    // The owner's screenshot: a green "Transcript live" pill on a buyer view
    // that was, at the same moment, stuck on "Waiting for the seller to start
    // their camera…". Stored moments prove captions EXIST, never that anything
    // is live now.
    const moments = [{
      id: 'moment-1',
      text: 'Center front.',
      startMs: 12_000,
      productId: 'bag',
      productTitle: 'Medication Bag',
    }];

    const stalled = remoteTranscriptPresentation(moments, { videoLive: false });
    expect(stalled.statusLabel).toBe('Captions from earlier in this event');
    // The pill's green is `state-listening`, so this is half the assertion, not
    // a restatement of the line above.
    expect(stalled.state).toBe('idle');

    // The captions themselves are still shown — they are real, and withholding
    // them would trade a false claim for a lost one.
    expect(stalled.segments).toEqual(moments);

    // And the live case is untouched.
    const playing = remoteTranscriptPresentation(moments, { videoLive: true });
    expect(playing.statusLabel).toBe('Transcript live');
    expect(playing.state).toBe('listening');
  });

  it('says "Last shown", not "On stage", once the buyer\'s video stops (WI-39868)', () => {
    // The other half of the owner's screenshot: beside the green pill WI-39839
    // fixed, the toolbar still read "On stage: Medication Bag" — asserting a
    // product was being presented at that moment. The feed is a poll of PERSISTED
    // moments, so it can only ever prove the event featured it at SOME point.
    const moments = [{
      id: 'moment-1',
      text: 'Center front.',
      startMs: 12_000,
      productId: 'bag',
      productTitle: 'Medication Bag',
    }];

    const stalled = remoteTranscriptPresentation(moments, { videoLive: false });
    // The product is NOT dropped — a buyer arriving mid-replay still learns what
    // was featured. The fix is to stop overclaiming, not to withhold.
    expect(stalled.activeProduct).toEqual({ id: 'bag', label: 'Medication Bag', live: false });

    // Asserted on the RENDERED MARKUP on purpose: WI-39839's first symptom shipped
    // as a correct-but-never-called helper, which a presentation-object test
    // cannot catch.
    const markup = renderToStaticMarkup(
      <VideoEngagementOverlay chat={<p>Room message</p>} transcript={stalled} />,
    );
    expect(markup).toContain('Last shown: <strong>Medication Bag</strong>');
    expect(markup).not.toContain('On stage');
    // The styling has to give up the claim with the words — the same reason
    // WI-39839 had to move the pill's colour and not just its label.
    expect(markup).toContain('live-transcript-active is-past');
  });

  it('CONTROL: the same moments DO say "On stage" while the video is playing', () => {
    // Without this the test above passes for a build that simply never renders a
    // product at all.
    const moments = [{
      id: 'moment-1',
      text: 'Center front.',
      startMs: 12_000,
      productId: 'bag',
      productTitle: 'Medication Bag',
    }];

    const playing = remoteTranscriptPresentation(moments, { videoLive: true });
    expect(playing.activeProduct).toEqual({ id: 'bag', label: 'Medication Bag', live: true });

    const markup = renderToStaticMarkup(
      <VideoEngagementOverlay chat={<p>Room message</p>} transcript={playing} />,
    );
    expect(markup).toContain('On stage: <strong>Medication Bag</strong>');
    expect(markup).not.toContain('Last shown');
    expect(markup).not.toContain('is-past');
  });

  it('leaves the SELLER capture path claiming "On stage" (WI-39868 blast radius)', () => {
    // `TranscriptOverlayView` is shared by both roles, so the buyer fix must not
    // reach the seller. Their activeProduct is the product THEY staged — their own
    // action read back, not an inference from what the captions mentioned — so the
    // present-tense claim is theirs to make and stays true even between utterances.
    const controller: LiveTranscriptController = {
      provider: 'deepgram',
      state: 'listening',
      finalSegments: [],
      interim: '',
      error: null,
      activeProduct: { id: 'lamp', label: 'Arc Table Lamp' },
      suggestedProduct: null,
      stageProduct: () => {},
      dismissSuggestion: () => {},
    };

    const presentation = liveTranscriptPresentation(controller);
    expect(presentation.activeProduct).toEqual({ id: 'lamp', label: 'Arc Table Lamp', live: true });

    const markup = renderToStaticMarkup(<TranscriptOverlayView transcript={presentation} />);
    expect(markup).toContain('On stage: <strong>Arc Table Lamp</strong>');
    expect(markup).not.toContain('is-past');
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
