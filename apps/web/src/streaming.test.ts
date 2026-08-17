import { describe, expect, it } from 'vitest';
import {
  buildMediaEndpoint,
  connectPublisher,
  connectViewer,
  createEventRoom,
  MediaTransportError,
  parseIceServerLinks,
} from './streaming';

const TURN_LINK = '<turns:media.sidestage.example:443?transport=tcp>; rel="ice-server"; '
  + 'username="1700000000:test"; credential="secret=="; credential-type="password"';

class FakeTrack {
  stopped = false;

  stop() {
    this.stopped = true;
  }
}

class FakeMediaStream {
  constructor(private readonly tracks: FakeTrack[] = []) {}

  getTracks() {
    return this.tracks;
  }

  addTrack(track: FakeTrack) {
    this.tracks.push(track);
  }
}

class FakePeerConnection {
  iceGatheringState: RTCIceGatheringState = 'new';
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onicegatheringstatechange: ((event: Event) => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  readonly tracks: Array<{ track: FakeTrack; stream: FakeMediaStream }> = [];
  readonly transceivers: string[] = [];
  closed = false;

  constructor(readonly configuration?: RTCConfiguration) {}

  addTrack(track: FakeTrack, stream: FakeMediaStream) {
    this.tracks.push({ track, stream });
    return {} as RTCRtpSender;
  }

  addTransceiver(kind: string) {
    this.transceivers.push(kind);
    return {} as RTCRtpTransceiver;
  }

  async createOffer() {
    return { type: 'offer' as const, sdp: 'v=0\no=fake-offer' };
  }

  async setLocalDescription(description: RTCSessionDescriptionInit) {
    this.localDescription = description as RTCSessionDescription;
    this.iceGatheringState = 'complete';
    this.onicegatheringstatechange?.(new Event('icegatheringstatechange'));
  }

  async setRemoteDescription(description: RTCSessionDescriptionInit) {
    this.remoteDescription = description;
  }

  close() {
    this.closed = true;
  }
}

function response(location = '/resource/1', status = 201): Response {
  return new Response('v=0\no=fake-answer', {
    status,
    headers: { 'Content-Type': 'application/sdp', Location: location },
  });
}

function optionsResponse(link = TURN_LINK): Response {
  return new Response(null, {
    status: 204,
    headers: link ? { Link: link } : undefined,
  });
}

describe('SideStage event streaming', () => {
  it('normalizes an event room and creates one stable buyer share link', () => {
    const room = createEventRoom('  Sunday-Drop  ', 'https://sidestage.example/live');

    expect(room.eventId).toBe('sunday-drop');
    expect(room.streamPath).toBe('sidestage-sunday-drop');
    expect(room.shareUrl).toBe('https://sidestage.example/live?event=sunday-drop&view=buyer');
    expect(buildMediaEndpoint(room, 'whip')).toBe(
      'http://localhost:8889/sidestage-sunday-drop/whip',
    );
    expect(buildMediaEndpoint(room, 'whep', { mediaBaseUrl: 'https://media.example/' })).toBe(
      'https://media.example/sidestage-sunday-drop/whep',
    );
  });

  it('rejects ids that could escape the MediaMTX path', () => {
    expect(() => createEventRoom('../private')).toThrow(/Event ids/);
    expect(() => createEventRoom('')).toThrow(/Event ids/);
  });

  it('parses MediaMTX ICE-server Link metadata before negotiation', () => {
    expect(parseIceServerLinks(
      `<stun:stun.example:3478>; rel="ice-server", ${TURN_LINK}`,
    )).toEqual([
      { urls: 'stun:stun.example:3478' },
      {
        urls: 'turns:media.sidestage.example:443?transport=tcp',
        username: '1700000000:test',
        credential: 'secret==',
        credentialType: 'password',
      },
    ]);
  });

  it('publishes camera and microphone tracks over WHIP and cleans up the resource', async () => {
    const room = createEventRoom('demo-event', 'https://sidestage.example/');
    const camera = new FakeTrack();
    const microphone = new FakeTrack();
    const localStream = new FakeMediaStream([camera, microphone]);
    const peerConnection = new FakePeerConnection();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      if (init?.method === 'OPTIONS') return optionsResponse();
      return response();
    };

    const session = await connectPublisher({
      room,
      mediaDevices: { getUserMedia: async () => localStream as unknown as MediaStream },
      peerConnectionFactory: (configuration) => {
        expect(configuration?.iceServers).toEqual([{
          urls: 'turns:media.sidestage.example:443?transport=tcp',
          username: '1700000000:test',
          credential: 'secret==',
          credentialType: 'password',
        }]);
        return peerConnection as unknown as RTCPeerConnection;
      },
      fetchImpl,
    });

    expect(peerConnection.tracks).toHaveLength(2);
    expect(requests[0]?.url).toBe('http://localhost:8889/sidestage-demo-event/whip');
    expect(requests[0]?.init?.method).toBe('OPTIONS');
    expect(requests[1]?.init?.method).toBe('POST');
    expect(requests[1]?.init?.body).toBe('v=0\no=fake-offer');
    expect(peerConnection.remoteDescription?.type).toBe('answer');
    expect(session.resourceUrl).toBe('http://localhost:8889/resource/1');

    await session.stop();
    await session.stop();
    expect(camera.stopped).toBe(true);
    expect(microphone.stopped).toBe(true);
    expect(peerConnection.closed).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests[2]?.init?.method).toBe('DELETE');
  });

  it('subscribes buyers with recvonly audio/video transceivers over WHEP', async () => {
    const room = createEventRoom('demo-event', 'https://sidestage.example/');
    const peerConnection = new FakePeerConnection();
    const requests: Array<{ url: string; method: string | undefined }> = [];

    const session = await connectViewer({
      room,
      peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
      mediaStreamFactory: () => new FakeMediaStream() as unknown as MediaStream,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), method: init?.method });
        if (init?.method === 'OPTIONS') return optionsResponse();
        return response('/resource/buyer-1');
      },
    });

    expect(peerConnection.transceivers).toEqual(['video', 'audio']);
    expect(requests[0]).toEqual({
      url: 'http://localhost:8889/sidestage-demo-event/whep',
      method: 'OPTIONS',
    });
    expect(requests[1]?.method).toBe('POST');
    await session.stop();
    expect(requests[2]).toEqual({
      url: 'http://localhost:8889/resource/buyer-1',
      method: 'DELETE',
    });
  });

  it('closes and releases local tracks when WHIP negotiation fails', async () => {
    const room = createEventRoom('demo-event');
    const camera = new FakeTrack();
    const microphone = new FakeTrack();
    const peerConnection = new FakePeerConnection();

    await expect(connectPublisher({
      room,
      mediaDevices: {
        getUserMedia: async () => new FakeMediaStream([camera, microphone]) as unknown as MediaStream,
      },
      peerConnectionFactory: () => peerConnection as unknown as RTCPeerConnection,
      fetchImpl: async (_url, init) => (
        init?.method === 'OPTIONS' ? optionsResponse() : response('', 503)
      ),
    })).rejects.toMatchObject({
      name: 'MediaTransportError',
      status: 503,
    } satisfies Partial<MediaTransportError>);

    expect(camera.stopped).toBe(true);
    expect(microphone.stopped).toBe(true);
    expect(peerConnection.closed).toBe(true);
  });

  it('turns an unanswered camera permission prompt into an actionable error instead of hanging', async () => {
    let factoryCalls = 0;
    const camera = new FakeTrack();
    // Simulates the browser leaving getUserMedia pending until the user
    // grants LATE — after the deadline already rejected the connect.
    let grant: (stream: MediaStream) => void = () => {};
    const lateGrant = new Promise<MediaStream>((resolve) => { grant = resolve; });

    await expect(connectPublisher({
      room: createEventRoom('demo-event'),
      mediaAcquireTimeoutMs: 20,
      mediaDevices: { getUserMedia: () => lateGrant },
      peerConnectionFactory: () => {
        factoryCalls += 1;
        return new FakePeerConnection() as unknown as RTCPeerConnection;
      },
      fetchImpl: async () => optionsResponse(),
    })).rejects.toMatchObject({
      name: 'MediaTransportError',
      message: expect.stringContaining('permission prompt'),
    });

    // No RTCPeerConnection may leak from a failed acquisition.
    expect(factoryCalls).toBe(0);

    // A grant landing after the deadline must not leave the camera running.
    grant(new FakeMediaStream([camera]) as unknown as MediaStream);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(camera.stopped).toBe(true);
  });

  it('maps a denied camera permission to a clear message', async () => {
    const denied = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    await expect(connectPublisher({
      room: createEventRoom('demo-event'),
      mediaDevices: { getUserMedia: () => Promise.reject(denied) },
      peerConnectionFactory: () => new FakePeerConnection() as unknown as RTCPeerConnection,
      fetchImpl: async () => optionsResponse(),
    })).rejects.toMatchObject({
      name: 'MediaTransportError',
      message: expect.stringContaining('blocked'),
    });
  });
});
