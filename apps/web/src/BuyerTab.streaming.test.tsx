/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BuyerTab } from './BuyerTab';
import {
  PUBLISHER_ABSENT_MESSAGE,
  PUBLISHER_RETRY_DELAYS_MS,
  WAITING_FOR_PUBLISHER_MESSAGE,
} from './buyer-stream-recovery';
import type { GuideEvent } from './events/api';
import { MediaTransportError, type ViewerSession } from './streaming';

const connectViewerMock = vi.hoisted(() => vi.fn());

vi.mock('./streaming', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./streaming')>();
  return { ...actual, connectViewer: connectViewerMock };
});

vi.mock('@papercusp/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/sync')>();
  return {
    ...actual,
    useSyncPrincipal: () => 'streaming-test-buyer',
    useSyncQuery: vi.fn(() => ({ data: [], error: null, invalidate: vi.fn() })),
    // BuyerTab's event.stats read is a useRestSyncQuery (WI-39772). The real
    // hook is a react-query consumer, so it needs a QueryClientProvider this
    // test does not mount — stub it like its useSyncQuery sibling.
    useRestSyncQuery: vi.fn(() => ({ data: [], error: null, invalidate: vi.fn() })),
    useSyncMutate: (_name: string, fallback: (input: unknown) => Promise<unknown>) => fallback,
  };
});

vi.mock('./AuctionPanel', () => ({ AuctionPanel: () => null }));
vi.mock('./VideoEngagementOverlay', () => ({
  remoteTranscriptPresentation: () => ({
    state: 'idle',
    segments: [],
    error: null,
    activeProduct: null,
    statusLabel: 'Waiting for captions',
    emptyLabel: 'Seller captions will appear here as the event unfolds.',
  }),
  nextTranscriptErrorState: (_prevStreak: number, error: unknown) => ({
    streak: error ? 1 : 0,
    confirmed: false,
  }),
  VideoEngagementOverlay: () => null,
}));

const STATS = { viewers: 0, itemsSold: 0, totalRaisedCents: 0 } as const;

function viewerSession() {
  const stop = vi.fn(async () => undefined);
  return {
    session: {
      peerConnection: {} as RTCPeerConnection,
      stream: {} as MediaStream,
      resourceUrl: null,
      stop,
    } satisfies ViewerSession,
    stop,
  };
}

function guideEvent(eventId: string, status: GuideEvent['status']): GuideEvent {
  return {
    eventId,
    title: `${eventId} title`,
    sellerId: 'seller-one',
    sellerName: 'Seller One',
    status,
    startsAt: null,
    endedAt: null,
    viewers: 0,
  };
}

function buyer(
  eventId: string,
  guideEvents: readonly GuideEvent[] = [guideEvent(eventId, 'live')],
) {
  return (
    <BuyerTab
      eventId={eventId}
      eventTitle={`${eventId} title`}
      products={[]}
      stats={STATS}
      guideEvents={guideEvents}
    />
  );
}

describe('BuyerTab stream lifecycle', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    connectViewerMock.mockReset();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('stays idle until the current guide event is live and disconnects when it ends', async () => {
    await act(async () => root?.render(buyer('guide-room', [])));
    expect(connectViewerMock).not.toHaveBeenCalled();

    await act(async () => root?.render(buyer('guide-room', [guideEvent('guide-room', 'scheduled')])));
    expect(connectViewerMock).not.toHaveBeenCalled();

    const live = viewerSession();
    connectViewerMock.mockResolvedValueOnce(live.session);
    await act(async () => root?.render(buyer('guide-room', [guideEvent('guide-room', 'live')])));

    expect(connectViewerMock).toHaveBeenCalledOnce();
    expect(connectViewerMock.mock.calls[0]?.[0].room.eventId).toBe('guide-room');
    expect(container.textContent).toContain('Disconnect');

    await act(async () => root?.render(buyer('guide-room', [guideEvent('guide-room', 'ended')])));
    expect(live.stop).toHaveBeenCalledOnce();
  });

  it('connects automatically and replaces an in-flight room without exposing a Connect button', async () => {
    const first = viewerSession();
    const second = viewerSession();
    let resolveFirst: ((session: ViewerSession) => void) | undefined;
    connectViewerMock
      .mockImplementationOnce(() => new Promise<ViewerSession>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(second.session);

    await act(async () => root?.render(buyer('first-room')));

    expect(connectViewerMock).toHaveBeenCalledTimes(1);
    expect(connectViewerMock.mock.calls[0]?.[0].room.eventId).toBe('first-room');
    expect(container.textContent).toContain('Connecting…');
    expect(container.textContent).not.toContain('Connect to stream');

    await act(async () => root?.render(buyer('second-room')));

    expect(connectViewerMock).toHaveBeenCalledTimes(2);
    expect(connectViewerMock.mock.calls[1]?.[0].room.eventId).toBe('second-room');
    expect(container.textContent).toContain('Disconnect');

    await act(async () => {
      resolveFirst?.(first.session);
      await Promise.resolve();
    });

    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).not.toHaveBeenCalled();

    await act(async () => root?.unmount());
    root = null;
    expect(second.stop).toHaveBeenCalledOnce();
  });

  it('offers Retry only after an automatic connection fails', async () => {
    const recovered = viewerSession();
    connectViewerMock
      .mockRejectedValueOnce(new Error('The seller is offline.'))
      .mockResolvedValueOnce(recovered.session);

    await act(async () => root?.render(buyer('retry-room')));

    expect(container.textContent).toContain('The seller is offline.');
    expect(container.textContent).toContain('Retry stream');
    expect(container.textContent).not.toContain('Connect to stream');

    const retry = [...container.querySelectorAll('button')]
      .find((button) => button.textContent === 'Retry stream');
    expect(retry).toBeDefined();
    await act(async () => retry?.click());

    expect(connectViewerMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain('Retry stream');
    expect(container.textContent).toContain('Disconnect');
  });
});

/**
 * Recurrence guards for the reported bug (WI-39733): "Media server rejected the
 * WHEP offer (404)" and a black pane that only a page reload recovered.
 *
 * MediaMTX answers WHEP with 404 while the path has no publisher, and going
 * live happens BEFORE the seller's camera grant — so every buyer already in the
 * room offers into that window. The viewer used to latch that 404 as a terminal
 * error and never re-offer while the event stayed live.
 *
 * The behaviour that must not regress is a pair, which is why both halves are
 * asserted together: a 404 re-offers on its own, and anything else still stops.
 * Testing only the first half would pass just as well against a viewer that
 * retried every failure forever, which is its own bug.
 */
describe('BuyerTab publisher wait (WI-39733)', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    connectViewerMock.mockReset();
    vi.useFakeTimers();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container.remove();
    vi.useRealTimers();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  /** Advance past the next scheduled re-offer and let its promises settle. */
  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  it('keeps re-offering after a WHEP 404 and connects when the seller appears', async () => {
    const recovered = viewerSession();
    // The seller is not publishing yet: the first two offers get MediaMTX's
    // "no publisher on this path" answer, then the camera comes up.
    connectViewerMock
      .mockRejectedValueOnce(new MediaTransportError('Media server rejected the WHEP offer (404).', 404))
      .mockRejectedValueOnce(new MediaTransportError('Media server rejected the WHEP offer (404).', 404))
      .mockResolvedValueOnce(recovered.session);

    await act(async () => root?.render(buyer('late-publisher-room')));

    // The 404 must not reach the buyer as an error, and must not park the UI
    // behind a manual Retry — that combination WAS the bug.
    expect(connectViewerMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(WAITING_FOR_PUBLISHER_MESSAGE);
    expect(container.textContent).not.toContain('404');
    expect(container.textContent).not.toContain('Retry stream');

    // Nothing external changes — only time passes. The old viewer stayed dark
    // here forever; this one re-offers on its own.
    await advance(PUBLISHER_RETRY_DELAYS_MS[0] ?? 1_000);
    expect(connectViewerMock).toHaveBeenCalledTimes(2);

    await advance(PUBLISHER_RETRY_DELAYS_MS[1] ?? 2_000);
    expect(connectViewerMock).toHaveBeenCalledTimes(3);

    // The publisher arrived: the buyer is watching, with no reload and no click.
    expect(container.textContent).toContain('Disconnect');
    expect(container.textContent).not.toContain(WAITING_FOR_PUBLISHER_MESSAGE);
  });

  it('stops after the bounded wait instead of polling a dead room forever', async () => {
    connectViewerMock.mockRejectedValue(
      new MediaTransportError('Media server rejected the WHEP offer (404).', 404),
    );

    await act(async () => root?.render(buyer('dead-room')));
    expect(connectViewerMock).toHaveBeenCalledTimes(1);

    // `End event` leaves rooms permanently `live` (WI-39737), so a buyer can
    // open a room whose seller is never coming. The wait must terminate.
    for (const delay of PUBLISHER_RETRY_DELAYS_MS) await advance(delay);

    const offers = connectViewerMock.mock.calls.length;
    expect(offers).toBe(PUBLISHER_RETRY_DELAYS_MS.length + 1);

    // Well past the whole schedule, it has genuinely stopped — not merely slowed.
    await advance(120_000);
    expect(connectViewerMock).toHaveBeenCalledTimes(offers);

    // And the buyer is told the actionable fact, not a transport status code.
    expect(container.textContent).toContain(PUBLISHER_ABSENT_MESSAGE);
    expect(container.textContent).not.toContain('404');
    expect(container.textContent).toContain('Retry stream');
  });

  it('still latches a non-404 failure immediately, without retrying', async () => {
    // The other half of the pair: a real fault must keep its old behaviour, or
    // genuine errors disappear behind a spinner for the length of the schedule.
    connectViewerMock.mockRejectedValue(new MediaTransportError('Media server unavailable.', 503));

    await act(async () => root?.render(buyer('broken-room')));

    expect(connectViewerMock).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('Media server unavailable.');
    expect(container.textContent).toContain('Retry stream');
    expect(container.textContent).not.toContain(WAITING_FOR_PUBLISHER_MESSAGE);

    // Time passing must change nothing for a real fault.
    await advance(60_000);
    expect(connectViewerMock).toHaveBeenCalledTimes(1);
  });

  it('abandons the wait when the event stops being live', async () => {
    connectViewerMock.mockRejectedValue(
      new MediaTransportError('Media server rejected the WHEP offer (404).', 404),
    );

    await act(async () => root?.render(buyer('ending-room')));
    expect(connectViewerMock).toHaveBeenCalledTimes(1);

    await act(async () => root?.render(buyer('ending-room', [guideEvent('ending-room', 'ended')])));

    // A scheduled re-offer must not fire into a room that is no longer live.
    await advance(60_000);
    expect(connectViewerMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Autoplay policy (WI-39774): Chrome REJECTS an unmuted `play()` with no user
 * gesture. The buyer player used to render unmuted, swallow that rejection, and
 * sit paused forever — a black pane while WebRTC stats showed packets flowing
 * and frames decoding underneath (measured on prod, 2026-08-18). Muted autoplay
 * is always policy-allowed, so the element ships muted and the native controls
 * carry the unmute.
 */
describe('BuyerTab autoplay policy (WI-39774)', () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    connectViewerMock.mockReset();
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    root = null;
    container.remove();
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders the player muted with autoplay so policy can never hold it black', async () => {
    connectViewerMock.mockResolvedValueOnce(viewerSession().session);
    await act(async () => root?.render(buyer('policy-room')));

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.muted).toBe(true);
    expect(video?.autoplay).toBe(true);
  });

  it('retries a rejected play() muted instead of leaving the pane black', async () => {
    connectViewerMock.mockResolvedValueOnce(viewerSession().session);
    await act(async () => root?.render(buyer('policy-room')));

    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    // Simulate the pre-fix world where the element reaches onTrack unmuted
    // (a future regression removing the attribute, or a user having unmuted
    // before a reconnect): the first play() rejects the way Chrome's policy
    // does, and the handler must mute and play again rather than give up.
    video!.muted = false;
    const play = vi
      .spyOn(HTMLMediaElement.prototype, 'play')
      .mockRejectedValueOnce(new DOMException('play() blocked', 'NotAllowedError'))
      .mockResolvedValue(undefined);
    try {
      const onTrack = connectViewerMock.mock.calls[0]?.[0].onTrack as
        (stream: MediaStream) => void;
      await act(async () => { onTrack({} as MediaStream); });

      expect(play).toHaveBeenCalledTimes(2);
      expect(video!.muted).toBe(true);
    } finally {
      play.mockRestore();
    }
  });
});
