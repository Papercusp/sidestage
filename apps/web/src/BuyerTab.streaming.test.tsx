/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BuyerTab } from './BuyerTab';
import type { ViewerSession } from './streaming';

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
    useSyncMutate: (_name: string, fallback: (input: unknown) => Promise<unknown>) => fallback,
  };
});

vi.mock('./AuctionPanel', () => ({ AuctionPanel: () => null }));
vi.mock('./ReplayChapters', () => ({ ReplayChapters: () => null }));
vi.mock('./VideoEngagementOverlay', () => ({
  remoteTranscriptPresentation: () => ({
    state: 'idle',
    segments: [],
    error: null,
    activeProduct: null,
    statusLabel: 'Waiting for captions',
    emptyLabel: 'Seller captions will appear here as the event unfolds.',
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

function buyer(eventId: string) {
  return (
    <BuyerTab
      eventId={eventId}
      eventTitle={`${eventId} title`}
      products={[]}
      stats={STATS}
      guideEvents={[]}
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
