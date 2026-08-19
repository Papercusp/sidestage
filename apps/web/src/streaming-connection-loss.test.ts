import { describe, expect, it } from 'vitest';

import { connectPublisher, connectViewer, type EventRoom } from './streaming';

/**
 * WI-39747: an established WebRTC session that falls over used to be invisible.
 * MediaMTX logged `closed: peer connection closed` while the app showed nothing
 * — the seller kept "broadcasting" to an empty path and buyers held a black
 * pane for the rest of the event. Neither `connectPublisher` nor `connectViewer`
 * had ANY connection-state handler, so nothing could react.
 *
 * These tests pin the signal that makes recovery possible at all.
 */

const room: EventRoom = {
  eventId: 'demo-event',
  streamPath: 'sidestage-demo-event',
  shareUrl: 'https://example.test/e/demo-event',
};

/**
 * A peer connection just real enough to negotiate and then drive
 * `connectionState` by hand. `close()` mimics the browser: it drives the state
 * to `closed` and fires the same handler a real fault would.
 */
function fakePeerConnection() {
  const connectionStateListeners = new Set<() => void>();
  const pc = {
    // A normal connect reaches `connected` before the transport returns the
    // session. Individual tests move this to `connecting` when exercising the
    // accepted-but-never-established path.
    connectionState: 'connected' as RTCPeerConnectionState,
    // 'complete' up front so `waitForIceGatheringComplete` resolves immediately;
    // these tests are about connection LOSS, not the gathering handshake.
    iceGatheringState: 'complete' as RTCIceGatheringState,
    onicegatheringstatechange: null as null | (() => void),
    addEventListener: (type: string, listener: () => void) => {
      if (type === 'connectionstatechange') connectionStateListeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === 'connectionstatechange') connectionStateListeners.delete(listener);
    },
    onconnectionstatechange: null as null | (() => void),
    ontrack: null as null | ((event: RTCTrackEvent) => void),
    localDescription: { type: 'offer', sdp: 'v=0' },
    addTrack: () => ({}),
    addTransceiver: () => ({}),
    createOffer: async () => ({ type: 'offer' as const, sdp: 'v=0' }),
    createAnswer: async () => ({ type: 'answer' as const, sdp: 'v=0' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    close: () => {
      pc.connectionState = 'closed';
      pc.onconnectionstatechange?.();
    },
    /** Drive a state transition the way the browser would on a real fault. */
    transitionTo(state: RTCPeerConnectionState) {
      pc.connectionState = state;
      pc.onconnectionstatechange?.();
      for (const listener of connectionStateListeners) listener();
    },
  };
  return pc;
}

function fakeFetch(): typeof fetch {
  return (async () => ({
    ok: true,
    status: 201,
    headers: new Headers({ Location: '/whip/resource/1' }),
    text: async () => 'v=0',
  })) as unknown as typeof fetch;
}

const mediaDevices = {
  getUserMedia: async () =>
    ({ getTracks: () => [{ stop: () => {} }] }) as unknown as MediaStream,
};

describe('established-connection loss is reported', () => {
  it('waits for the peer connection to establish before returning the accepted WHEP session', async () => {
    const pc = fakePeerConnection();
    pc.connectionState = 'connecting';

    const connecting = connectViewer({
      room,
      mediaBaseUrl: 'http://media.test',
      connectionEstablishmentTimeoutMs: 200,
      fetchImpl: fakeFetch(),
      peerConnectionFactory: () => pc as unknown as RTCPeerConnection,
      mediaStreamFactory: () => ({ getTracks: () => [], addTrack: () => {} }) as unknown as MediaStream,
    });

    globalThis.setTimeout(() => pc.transitionTo('connected'), 10);
    await expect(connecting).resolves.toMatchObject({
      resourceUrl: 'http://media.test/whip/resource/1',
    });
  });

  it('rejects and releases a WHEP session that MediaMTX accepted but ICE never established', async () => {
    const pc = fakePeerConnection();
    pc.connectionState = 'connecting';
    const methods: Array<string | undefined> = [];

    await expect(connectViewer({
      room,
      mediaBaseUrl: 'http://media.test',
      connectionEstablishmentTimeoutMs: 20,
      fetchImpl: (async (_url, init) => {
        methods.push(init?.method);
        return {
          ok: true,
          status: init?.method === 'OPTIONS' ? 204 : 201,
          headers: new Headers(init?.method === 'POST' ? { Location: '/whep/resource/1' } : {}),
          text: async () => 'v=0',
        } as Response;
      }) as typeof fetch,
      peerConnectionFactory: () => pc as unknown as RTCPeerConnection,
      mediaStreamFactory: () => ({ getTracks: () => [], addTrack: () => {} }) as unknown as MediaStream,
    })).rejects.toMatchObject({
      name: 'MediaTransportError',
      message: expect.stringContaining('did not establish'),
    });

    expect(pc.connectionState).toBe('closed');
    expect(methods).toEqual(['OPTIONS', 'POST', 'DELETE']);
  });

  it('publisher: reports a failed connection so the seller learns the broadcast died', async () => {
    const pc = fakePeerConnection();
    const lost: RTCPeerConnectionState[] = [];

    await connectPublisher({
      room,
      mediaBaseUrl: 'http://media.test',
      fetchImpl: fakeFetch(),
      mediaDevices,
      peerConnectionFactory: () => pc as unknown as RTCPeerConnection,
      onConnectionLost: (state) => lost.push(state),
    });

    expect(lost).toEqual([]); // nothing reported while healthy
    pc.transitionTo('failed');
    expect(lost).toEqual(['failed']);
  });

  it('viewer: reports a failed connection — the case the WHEP 404 retry cannot see', async () => {
    const pc = fakePeerConnection();
    const lost: RTCPeerConnectionState[] = [];

    await connectViewer({
      room,
      mediaBaseUrl: 'http://media.test',
      fetchImpl: fakeFetch(),
      peerConnectionFactory: () => pc as unknown as RTCPeerConnection,
      mediaStreamFactory: () => ({ getTracks: () => [], addTrack: () => {} }) as unknown as MediaStream,
      onConnectionLost: (state) => lost.push(state),
    });

    pc.transitionTo('failed');
    expect(lost).toEqual(['failed']);
  });

  it('does NOT report a deliberate stop() — close() drives state to closed, which is not a fault', async () => {
    const pc = fakePeerConnection();
    const lost: RTCPeerConnectionState[] = [];

    const session = await connectViewer({
      room,
      mediaBaseUrl: 'http://media.test',
      fetchImpl: fakeFetch(),
      peerConnectionFactory: () => pc as unknown as RTCPeerConnection,
      mediaStreamFactory: () => ({ getTracks: () => [], addTrack: () => {} }) as unknown as MediaStream,
      onConnectionLost: (state) => lost.push(state),
    });

    await session.stop();
    expect(lost).toEqual([]);

    // The case that actually EXERCISES the stopped-guard. `close()` alone only
    // reaches 'closed', which is not a fault state, so it would pass even with
    // the guard removed. A teardown that races a real failure DOES reach
    // 'failed' after stop() — and reporting it there re-arms recovery against a
    // stream the user deliberately ended. Delete the `isStopped()` check in
    // watchConnectionState and this assertion is what fails.
    pc.transitionTo('failed');
    expect(lost).toEqual([]);
  });

  it('does NOT report `disconnected` — ICE recovers from it routinely', async () => {
    const pc = fakePeerConnection();
    const lost: RTCPeerConnectionState[] = [];

    await connectViewer({
      room,
      mediaBaseUrl: 'http://media.test',
      fetchImpl: fakeFetch(),
      peerConnectionFactory: () => pc as unknown as RTCPeerConnection,
      mediaStreamFactory: () => ({ getTracks: () => [], addTrack: () => {} }) as unknown as MediaStream,
      onConnectionLost: (state) => lost.push(state),
    });

    pc.transitionTo('disconnected');
    expect(lost).toEqual([]);

    // ...and still reports once it genuinely fails.
    pc.transitionTo('failed');
    expect(lost).toEqual(['failed']);
  });

  it('reports at most once, so a flapping connection cannot storm the caller', async () => {
    const pc = fakePeerConnection();
    const lost: RTCPeerConnectionState[] = [];

    await connectViewer({
      room,
      mediaBaseUrl: 'http://media.test',
      fetchImpl: fakeFetch(),
      peerConnectionFactory: () => pc as unknown as RTCPeerConnection,
      mediaStreamFactory: () => ({ getTracks: () => [], addTrack: () => {} }) as unknown as MediaStream,
      onConnectionLost: (state) => lost.push(state),
    });

    pc.transitionTo('failed');
    pc.transitionTo('failed');
    pc.transitionTo('failed');
    expect(lost).toEqual(['failed']);
  });
});
