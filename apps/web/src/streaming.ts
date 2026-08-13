/**
 * Browser-side MediaMTX WHIP/WHEP transport for one SideStage event.
 *
 * MediaMTX keeps the media plane independent from the seller/buyer SPA:
 * sellers publish one event path with WHIP and buyers subscribe to that same
 * path with WHEP. The returned resource URL is retained so a session can be
 * explicitly deleted when it ends instead of leaving a stale peer around.
 */

export const DEFAULT_MEDIAMTX_BASE_URL = 'http://localhost:8889';

const EVENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type MediaEndpointKind = 'whip' | 'whep';

export interface EventRoom {
  readonly eventId: string;
  /** The path shared by WHIP and WHEP for this event. */
  readonly streamPath: string;
  /** A buyer-facing URL that preserves the event id without a server session. */
  readonly shareUrl: string;
}

export interface StreamingConfig {
  /** MediaMTX HTTP/WebRTC server, normally http://localhost:8889 locally. */
  readonly mediaBaseUrl?: string;
  /** Optional override when WHIP and WHEP are served by different origins. */
  readonly whipBaseUrl?: string;
  readonly whepBaseUrl?: string;
}

export interface PeerConnectionFactory {
  (): RTCPeerConnection;
}

export interface MediaDevicesProvider {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
}

export interface MediaStreamFactory {
  (): MediaStream;
}

export interface PublisherSession {
  readonly peerConnection: RTCPeerConnection;
  readonly localStream: MediaStream;
  readonly resourceUrl: string | null;
  stop(): Promise<void>;
}

export interface ViewerSession {
  readonly peerConnection: RTCPeerConnection;
  /** Updated when MediaMTX delivers the first remote stream. */
  readonly stream: MediaStream;
  readonly resourceUrl: string | null;
  stop(): Promise<void>;
}

export interface PublisherOptions extends StreamingConfig {
  readonly room: EventRoom;
  readonly fetchImpl?: typeof fetch;
  readonly mediaDevices?: MediaDevicesProvider;
  readonly peerConnectionFactory?: PeerConnectionFactory;
}

export interface ViewerOptions extends StreamingConfig {
  readonly room: EventRoom;
  readonly fetchImpl?: typeof fetch;
  readonly peerConnectionFactory?: PeerConnectionFactory;
  readonly mediaStreamFactory?: MediaStreamFactory;
  readonly onTrack?: (stream: MediaStream, event: RTCTrackEvent) => void;
}

export class MediaTransportError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MediaTransportError';
    this.status = status;
  }
}

/**
 * Create the stable identity used by a seller and all buyers for an event.
 * Event ids intentionally use a narrow URL-safe alphabet because they become
 * a MediaMTX path segment and are copied into public share links.
 */
export function createEventRoom(eventId: string, origin = getBrowserOrigin()): EventRoom {
  const normalizedEventId = eventId.trim().toLowerCase();
  if (!EVENT_ID_PATTERN.test(normalizedEventId)) {
    throw new Error(
      'Event ids must start with a letter or number and contain only lowercase letters, numbers, or hyphens.',
    );
  }

  const shareUrl = new URL(origin);
  shareUrl.search = '';
  shareUrl.hash = '';
  shareUrl.searchParams.set('event', normalizedEventId);
  shareUrl.searchParams.set('view', 'buyer');

  return {
    eventId: normalizedEventId,
    streamPath: `sidestage-${normalizedEventId}`,
    shareUrl: shareUrl.toString(),
  };
}

export function buildMediaEndpoint(
  room: EventRoom,
  kind: MediaEndpointKind,
  config: StreamingConfig = {},
): string {
  const baseUrl = kind === 'whip'
    ? config.whipBaseUrl ?? config.mediaBaseUrl ?? DEFAULT_MEDIAMTX_BASE_URL
    : config.whepBaseUrl ?? config.mediaBaseUrl ?? DEFAULT_MEDIAMTX_BASE_URL;
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  return `${normalizedBaseUrl}/${encodeURIComponent(room.streamPath)}/${kind}`;
}

/**
 * Wait until ICE candidates have been included in the local SDP. MediaMTX's
 * WHIP/WHEP endpoints expect the complete offer in the POST body.
 */
export function waitForIceGatheringComplete(
  peerConnection: RTCPeerConnection,
  timeoutMs = 10_000,
): Promise<void> {
  if (peerConnection.iceGatheringState === 'complete') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const previousHandler = peerConnection.onicegatheringstatechange;
    const timeout = globalThis.setTimeout(() => {
      settle(new MediaTransportError('Timed out while gathering media ICE candidates.'));
    }, timeoutMs);

    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      peerConnection.onicegatheringstatechange = previousHandler;
      if (error) reject(error);
      else resolve();
    };

    peerConnection.onicegatheringstatechange = (event) => {
      previousHandler?.call(peerConnection, event);
      if (peerConnection.iceGatheringState === 'complete') settle();
    };

    // A state transition can happen between the initial check and installing
    // the handler, especially in test doubles and fast local connections.
    if (peerConnection.iceGatheringState === 'complete') settle();
  });
}

async function negotiate(
  peerConnection: RTCPeerConnection,
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  await waitForIceGatheringComplete(peerConnection);

  const localDescription = peerConnection.localDescription;
  if (!localDescription?.sdp) {
    throw new MediaTransportError('The browser did not produce a local media offer.');
  }

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: localDescription.sdp,
  });
  if (!response.ok) {
    throw new MediaTransportError(
      `Media server rejected the ${endpoint.endsWith('/whip') ? 'WHIP' : 'WHEP'} offer (${response.status}).`,
      response.status,
    );
  }

  const answerSdp = await response.text();
  if (!answerSdp.trim()) {
    throw new MediaTransportError('Media server returned an empty SDP answer.');
  }
  await peerConnection.setRemoteDescription({ type: 'answer', sdp: answerSdp });

  const location = response.headers.get('Location');
  return location ? new URL(location, endpoint).toString() : null;
}

function defaultPeerConnectionFactory(): RTCPeerConnection {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new MediaTransportError('WebRTC is unavailable in this browser.');
  }
  return new RTCPeerConnection();
}

function defaultMediaDevices(): MediaDevicesProvider {
  if (!globalThis.navigator?.mediaDevices) {
    throw new MediaTransportError('Camera and microphone access is unavailable in this browser.');
  }
  return globalThis.navigator.mediaDevices;
}

function defaultMediaStreamFactory(): MediaStream {
  if (typeof MediaStream === 'undefined') {
    throw new MediaTransportError('Media streams are unavailable in this browser.');
  }
  return new MediaStream();
}

function getBrowserOrigin(): string {
  return typeof globalThis.location?.origin === 'string'
    ? globalThis.location.origin
    : 'http://localhost:5173/';
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

async function deleteResource(resourceUrl: string | null, fetchImpl: typeof fetch): Promise<void> {
  if (!resourceUrl) return;
  const response = await fetchImpl(resourceUrl, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    throw new MediaTransportError(`Media session cleanup failed (${response.status}).`, response.status);
  }
}

export async function connectPublisher(options: PublisherOptions): Promise<PublisherSession> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const mediaDevices = options.mediaDevices ?? defaultMediaDevices();
  const peerConnection = (options.peerConnectionFactory ?? defaultPeerConnectionFactory)();
  const localStream = await mediaDevices.getUserMedia({ video: true, audio: true });
  for (const track of localStream.getTracks()) peerConnection.addTrack(track, localStream);

  let resourceUrl: string | null = null;
  try {
    resourceUrl = await negotiate(
      peerConnection,
      buildMediaEndpoint(options.room, 'whip', options),
      fetchImpl,
    );
  } catch (error) {
    stopTracks(localStream);
    peerConnection.close();
    throw error;
  }

  let stopped = false;
  return {
    peerConnection,
    localStream,
    resourceUrl,
    async stop() {
      if (stopped) return;
      stopped = true;
      stopTracks(localStream);
      peerConnection.close();
      await deleteResource(resourceUrl, fetchImpl);
    },
  };
}

export async function connectViewer(options: ViewerOptions): Promise<ViewerSession> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const peerConnection = (options.peerConnectionFactory ?? defaultPeerConnectionFactory)();
  let viewerStream = (options.mediaStreamFactory ?? defaultMediaStreamFactory)();
  peerConnection.ontrack = (event) => {
    viewerStream = event.streams[0] ?? viewerStream;
    if (!event.streams[0] && !viewerStream.getTracks().includes(event.track)) {
      viewerStream.addTrack(event.track);
    }
    options.onTrack?.(viewerStream, event);
  };
  peerConnection.addTransceiver('video', { direction: 'recvonly' });
  peerConnection.addTransceiver('audio', { direction: 'recvonly' });

  let resourceUrl: string | null = null;
  try {
    resourceUrl = await negotiate(
      peerConnection,
      buildMediaEndpoint(options.room, 'whep', options),
      fetchImpl,
    );
  } catch (error) {
    peerConnection.close();
    throw error;
  }

  let stopped = false;
  return {
    peerConnection,
    get stream() {
      return viewerStream;
    },
    resourceUrl,
    async stop() {
      if (stopped) return;
      stopped = true;
      peerConnection.close();
      await deleteResource(resourceUrl, fetchImpl);
    },
  };
}
