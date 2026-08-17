/**
 * Browser-side MediaMTX WHIP/WHEP transport for one SideStage event.
 *
 * MediaMTX keeps the media plane independent from the seller/buyer SPA:
 * sellers publish one event path with WHIP and buyers subscribe to that same
 * path with WHEP. The returned resource URL is retained so a session can be
 * explicitly deleted when it ends instead of leaving a stale peer around.
 */

export const DEFAULT_MEDIAMTX_BASE_URL = 'http://localhost:8889';

/** An undecided browser permission prompt keeps getUserMedia pending forever;
 * this deadline turns that silence into an actionable error. */
export const DEFAULT_MEDIA_ACQUIRE_TIMEOUT_MS = 20_000;

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
  (configuration?: RTCConfiguration): RTCPeerConnection;
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
  /** Deadline for the camera/mic permission grant (default 20s). */
  readonly mediaAcquireTimeoutMs?: number;
  /** Budget for ICE gathering before the offer is sent as-is (default 10s). */
  readonly iceGatheringTimeoutMs?: number;
  /**
   * Called when an ESTABLISHED publish falls over (see `isLostConnectionState`).
   * Without this the seller keeps "broadcasting" to an empty path: the
   * connection is gone, nothing surfaces it, and buyers see a black pane for the
   * rest of the event. Not called for a deliberate `stop()`.
   */
  readonly onConnectionLost?: (state: RTCPeerConnectionState) => void;
}

export interface ViewerOptions extends StreamingConfig {
  readonly room: EventRoom;
  readonly fetchImpl?: typeof fetch;
  readonly peerConnectionFactory?: PeerConnectionFactory;
  readonly mediaStreamFactory?: MediaStreamFactory;
  readonly onTrack?: (stream: MediaStream, event: RTCTrackEvent) => void;
  /** Budget for ICE gathering before the offer is sent as-is (default 10s). */
  readonly iceGatheringTimeoutMs?: number;
  /**
   * Called when an ESTABLISHED subscription falls over. The WHEP 404 retry only
   * covers "the publisher has not started yet"; a stream that arrives and then
   * dies never produces that 404, so this is the only signal that distinguishes
   * a dead stream from a working one. Not called for a deliberate `stop()`.
   */
  readonly onConnectionLost?: (state: RTCPeerConnectionState) => void;
}

/**
 * A peer-connection state meaning the media is gone and will not come back on
 * its own. `failed` is terminal for an established session; `disconnected` is
 * routinely transient (ICE recovers from it) and firing on it would tear down
 * working streams.
 *
 * This is the SINGLE definition for both the transport layer and the buyer
 * retry path: `buyer-stream-recovery.ts` re-exports it as `isLostConnectionState`.
 * The dependency runs one way (buyer-recovery -> streaming), so there is no cycle.
 */
export function isLostPeerConnectionState(state: RTCPeerConnectionState): boolean {
  return state === 'failed';
}

/**
 * Report an established connection falling over, exactly once, and never for a
 * deliberate `stop()` — `close()` drives the state to `closed`, which must not
 * be reported as a fault.
 */
function watchConnectionState(
  peerConnection: RTCPeerConnection,
  onConnectionLost: ((state: RTCPeerConnectionState) => void) | undefined,
  isStopped: () => boolean,
): void {
  if (!onConnectionLost) return;
  let reported = false;
  peerConnection.onconnectionstatechange = () => {
    if (reported || isStopped()) return;
    const state = peerConnection.connectionState;
    if (!isLostPeerConnectionState(state)) return;
    reported = true;
    onConnectionLost(state);
  };
}

export class MediaTransportError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'MediaTransportError';
    this.status = status;
  }
}

function linkParameter(link: string, name: string): string | null {
  const match = link.match(
    new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"((?:\\\\.|[^"])*)"|([^;\\s]+))`, 'i'),
  );
  const value = match?.[1] ?? match?.[2];
  return value ? value.replace(/\\(["\\])/g, '$1') : null;
}

/**
 * Parse the standard WHIP/WHEP `Link: ...; rel="ice-server"` metadata that
 * MediaMTX exposes from endpoint OPTIONS requests. Fetch combines repeated
 * Link fields with commas, so split only at the beginning of the next link.
 */
export function parseIceServerLinks(linkHeader: string | null): RTCIceServer[] {
  if (!linkHeader) return [];

  return linkHeader.split(/,(?=\s*<)/).flatMap((link) => {
    const url = link.match(/^\s*<([^>]+)>/)?.[1];
    const rel = linkParameter(link, 'rel');
    if (!url || !rel?.split(/\s+/).includes('ice-server')) return [];

    const username = linkParameter(link, 'username');
    const credential = linkParameter(link, 'credential');
    const credentialType = linkParameter(link, 'credential-type');

    return [{
      urls: url,
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
      ...(credentialType === 'password' ? { credentialType: 'password' as const } : {}),
    }];
  });
}

async function discoverIceServers(
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<RTCIceServer[]> {
  const response = await fetchImpl(endpoint, { method: 'OPTIONS' });
  if (!response.ok) {
    throw new MediaTransportError(
      `Media server rejected ICE server discovery (${response.status}).`,
      response.status,
    );
  }
  return parseIceServerLinks(response.headers.get('Link'));
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
 * How long negotiation waits for ICE gathering before offering the candidates
 * it already has.
 *
 * Deliberately generous, and deliberately NOT shortened: WHIP/WHEP is vanilla
 * ICE, so candidates that arrive after the POST are never delivered to the
 * server. Production advertises a single TURN relay reached over TCP/TLS on
 * 443, which can legitimately take several seconds to allocate on a slow
 * network — cutting the budget would silently drop that relay candidate from
 * the offer and break exactly the constrained networks that need it most.
 * Expiry is cheap because it is no longer fatal (see below); truncating the
 * wait is not.
 */
export const DEFAULT_ICE_GATHERING_TIMEOUT_MS = 10_000;

/**
 * Whether gathering finished, or the budget expired with candidates still
 * outstanding. `partial` is a normal, shippable outcome — not an error.
 */
export type IceGatheringOutcome = 'complete' | 'partial';

/** Vanilla-ICE SDP carries its candidates inline as `a=candidate:` lines. */
export function sdpHasIceCandidate(sdp: string): boolean {
  return /^a=candidate:/m.test(sdp);
}

/**
 * Wait until ICE candidates have been included in the local SDP. MediaMTX's
 * WHIP/WHEP endpoints expect a vanilla-ICE offer in the POST body, so we prefer
 * a fully gathered one.
 *
 * On timeout this RESOLVES `partial` rather than rejecting. Relay candidates are
 * a fallback, and MediaMTX publishes its own public address as a host candidate,
 * so the candidates already in the local description are usually enough to
 * connect. Aborting here instead would turn one unreachable TURN server into a
 * total streaming outage — with no server-side trace, because the offer would
 * never be POSTed at all. The caller decides what a `partial` offer is worth.
 */
export function waitForIceGatheringComplete(
  peerConnection: RTCPeerConnection,
  timeoutMs = DEFAULT_ICE_GATHERING_TIMEOUT_MS,
): Promise<IceGatheringOutcome> {
  if (peerConnection.iceGatheringState === 'complete') {
    return Promise.resolve('complete');
  }

  return new Promise((resolve) => {
    let settled = false;
    const previousHandler = peerConnection.onicegatheringstatechange;
    const timeout = globalThis.setTimeout(() => settle('partial'), timeoutMs);

    const settle = (outcome: IceGatheringOutcome) => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      peerConnection.onicegatheringstatechange = previousHandler;
      resolve(outcome);
    };

    peerConnection.onicegatheringstatechange = (event) => {
      previousHandler?.call(peerConnection, event);
      if (peerConnection.iceGatheringState === 'complete') settle('complete');
    };

    // A state transition can happen between the initial check and installing
    // the handler, especially in test doubles and fast local connections.
    if (peerConnection.iceGatheringState === 'complete') settle('complete');
  });
}

async function negotiate(
  peerConnection: RTCPeerConnection,
  endpoint: string,
  fetchImpl: typeof fetch,
  iceGatheringTimeoutMs = DEFAULT_ICE_GATHERING_TIMEOUT_MS,
): Promise<string | null> {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  const gathering = await waitForIceGatheringComplete(peerConnection, iceGatheringTimeoutMs);

  const localDescription = peerConnection.localDescription;
  if (!localDescription?.sdp) {
    throw new MediaTransportError('The browser did not produce a local media offer.');
  }
  // Only a gathering stall that produced NOTHING is fatal. A partial offer still
  // carries host candidates, which is the path that actually connects to
  // MediaMTX; sending it is strictly better than never POSTing at all.
  if (gathering === 'partial' && !sdpHasIceCandidate(localDescription.sdp)) {
    throw new MediaTransportError('Timed out while gathering media ICE candidates.');
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

function defaultPeerConnectionFactory(configuration?: RTCConfiguration): RTCPeerConnection {
  if (typeof RTCPeerConnection === 'undefined') {
    throw new MediaTransportError('WebRTC is unavailable in this browser.');
  }
  return new RTCPeerConnection(configuration);
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

/**
 * Camera/mic acquisition wrapped so an unanswered permission prompt cannot
 * hang the connect forever — the browser keeps getUserMedia PENDING while its
 * permission prompt is undecided, which left the seller console on
 * "Starting…" indefinitely with no feedback. Permission/device failures are
 * mapped to actionable messages instead of raw DOMException names.
 */
async function acquireLocalStream(
  mediaDevices: MediaDevicesProvider,
  timeoutMs: number,
): Promise<MediaStream> {
  const request = mediaDevices.getUserMedia({ video: true, audio: true });
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(() => {
          // A grant that lands after this deadline would orphan live tracks;
          // release them so the camera light does not stay on.
          request.then((stream) => stopTracks(stream)).catch(() => {});
          reject(new MediaTransportError(
            'Timed out waiting for camera and microphone access. Check the browser permission prompt, allow access for this site, then try again.',
          ));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (error instanceof MediaTransportError) throw error;
    const name = (error as DOMException | undefined)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new MediaTransportError('Camera and microphone access is blocked for this site. Allow it from the browser address bar, then try again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new MediaTransportError('No camera or microphone was found on this device.');
    }
    if (name === 'NotReadableError') {
      throw new MediaTransportError('The camera or microphone is already in use by another application.');
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export async function connectPublisher(options: PublisherOptions): Promise<PublisherSession> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const mediaDevices = options.mediaDevices ?? defaultMediaDevices();
  const endpoint = buildMediaEndpoint(options.room, 'whip', options);
  const iceServers = await discoverIceServers(endpoint, fetchImpl);
  // Acquire media BEFORE creating the peer connection: a permission denial or
  // timeout then cannot leak a never-closed RTCPeerConnection.
  const localStream = await acquireLocalStream(
    mediaDevices,
    options.mediaAcquireTimeoutMs ?? DEFAULT_MEDIA_ACQUIRE_TIMEOUT_MS,
  );
  const peerConnection = (options.peerConnectionFactory ?? defaultPeerConnectionFactory)(
    iceServers.length > 0 ? { iceServers } : undefined,
  );
  for (const track of localStream.getTracks()) peerConnection.addTrack(track, localStream);

  let resourceUrl: string | null = null;
  try {
    resourceUrl = await negotiate(
      peerConnection,
      endpoint,
      fetchImpl,
      options.iceGatheringTimeoutMs,
    );
  } catch (error) {
    stopTracks(localStream);
    peerConnection.close();
    throw error;
  }

  let stopped = false;
  watchConnectionState(peerConnection, options.onConnectionLost, () => stopped);
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
  const endpoint = buildMediaEndpoint(options.room, 'whep', options);
  const iceServers = await discoverIceServers(endpoint, fetchImpl);
  const peerConnection = (options.peerConnectionFactory ?? defaultPeerConnectionFactory)(
    iceServers.length > 0 ? { iceServers } : undefined,
  );
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
      endpoint,
      fetchImpl,
      options.iceGatheringTimeoutMs,
    );
  } catch (error) {
    peerConnection.close();
    throw error;
  }

  let stopped = false;
  watchConnectionState(peerConnection, options.onConnectionLost, () => stopped);
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
