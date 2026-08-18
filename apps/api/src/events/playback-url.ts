/**
 * Where a stream lives, answered by the SERVER (D-035, WI-38805).
 *
 * The web derives its WHEP endpoint client-side from a build-time env var plus
 * a `sidestage-` path prefix (apps/web/src/streaming.ts). Repeating that
 * derivation in each mobile client would create a second source of truth about
 * where the stream lives — the fork D-001 exists to prevent. So the directory
 * payload carries the full playback endpoint, computed here and nowhere else,
 * and clients do zero URL construction.
 *
 * `MEDIAMTX_WHEP_URL` must be the base the CALLER can reach: the public
 * `https://media.<hostname>` in production, the compose-internal
 * `http://mediamtx:8889` in acceptance. Unset means this deployment has no
 * media plane — the honest answer is `null`, not a guessed localhost.
 */

/** MediaMTX path names are `sidestage-<eventId>`; same grammar the web's
 * `createEventRoom` publishes to via WHIP. */
const STREAM_PATH_PREFIX = 'sidestage-';

export function whepPlaybackUrl(
  eventId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const base = env.MEDIAMTX_WHEP_URL?.trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/${encodeURIComponent(`${STREAM_PATH_PREFIX}${eventId}`)}/whep`;
}
