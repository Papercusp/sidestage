/**
 * Event thumbnail: validation + encoding.
 *
 * SideStage has no image-storage service. `mediaBaseUrl()` is the MediaMTX
 * WHIP/WHEP endpoint for LIVE VIDEO (see ../event-identity.ts and
 * ../streaming.ts) — it does not store files, so an uploaded thumbnail cannot
 * go there. Rather than stand up an object store for one small image, an
 * uploaded file is validated and encoded as a `data:` URL and persisted as a
 * plain string on the event config (which is already a jsonb payload, so no
 * migration is involved).
 *
 * The field is deliberately ONE string that holds either a `data:` URL or an
 * ordinary `https:` URL. Both render from the same `<img src>`, so the buyer
 * side never branches on provenance — and moving to real object storage later
 * changes only what `readThumbnailFile` returns, not the schema, the API, or
 * any renderer.
 *
 * The byte cap is what keeps that trade-off honest: a data URL is inlined into
 * every read of the event config, so an unbounded one would bloat a hot
 * payload. 512KB is comfortably enough for a thumbnail and small enough that
 * the encoded row stays well inside a sane request body.
 */

/** Formats a browser can decode and that survive base64 round-tripping. */
export const ALLOWED_THUMBNAIL_TYPES: readonly string[] = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
];

/**
 * Cap on the RAW file, checked before encoding. base64 inflates by ~4/3, so
 * the stored string is ~683KB at the limit.
 */
export const MAX_THUMBNAIL_BYTES = 512 * 1024;

export type ThumbnailCheck = { ok: true } | { ok: false; error: string };

/** The subset of `File` this module needs, so tests need no DOM File. */
export interface ThumbnailFileLike {
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

/** Human list for error copy: "JPEG, PNG, WebP, or GIF". */
function allowedLabel(): string {
  const labels = ALLOWED_THUMBNAIL_TYPES.map((type) => {
    const sub = type.slice('image/'.length);
    return sub === 'jpeg' ? 'JPEG' : sub === 'webp' ? 'WebP' : sub.toUpperCase();
  });
  return `${labels.slice(0, -1).join(', ')}, or ${labels.at(-1)}`;
}

/**
 * Validate a picked file WITHOUT reading it. Separated from the encode step so
 * an oversized file is rejected before its bytes are ever pulled into memory.
 */
export function validateThumbnailFile(file: ThumbnailFileLike): ThumbnailCheck {
  if (!ALLOWED_THUMBNAIL_TYPES.includes(file.type)) {
    // An empty type is what a browser reports for an extensionless or unknown
    // file; naming the accepted set is more useful than echoing "".
    return { ok: false, error: `Thumbnail must be a ${allowedLabel()} image.` };
  }
  if (file.size <= 0) {
    return { ok: false, error: 'That image file is empty.' };
  }
  if (file.size > MAX_THUMBNAIL_BYTES) {
    return {
      ok: false,
      error: `Thumbnail must be ${formatBytes(MAX_THUMBNAIL_BYTES)} or smaller (that one is ${formatBytes(file.size)}).`,
    };
  }
  return { ok: true };
}

/**
 * Base64 without FileReader.
 *
 * FileReader is a DOM API, so a FileReader-based encoder can only be tested
 * under jsdom and forces every caller into an event-callback shape. Going
 * through `arrayBuffer()` keeps this a plain async function that runs
 * identically in the browser and in a node test.
 */
function toBase64(bytes: Uint8Array): string {
  // Chunked so a large image cannot blow the argument limit on spread.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  if (typeof btoa === 'function') return btoa(binary);
  return Buffer.from(binary, 'binary').toString('base64');
}

export type ThumbnailRead =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string };

/**
 * Validate then encode a picked file into a `data:` URL suitable for
 * `EventCreationPayload.thumbnailUrl`.
 */
export async function readThumbnailFile(file: ThumbnailFileLike): Promise<ThumbnailRead> {
  const check = validateThumbnailFile(file);
  if (!check.ok) return check;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // A file can be truncated between the size check and the read (a removable
    // drive, a file replaced mid-pick). Trust the bytes we actually got.
    if (bytes.length === 0) return { ok: false, error: 'That image file is empty.' };
    if (bytes.length > MAX_THUMBNAIL_BYTES) {
      return { ok: false, error: `Thumbnail must be ${formatBytes(MAX_THUMBNAIL_BYTES)} or smaller.` };
    }
    return { ok: true, dataUrl: `data:${file.type};base64,${toBase64(bytes)}` };
  } catch {
    return { ok: false, error: 'Could not read that image file.' };
  }
}

/**
 * Is this string safe to hand to `<img src>`?
 *
 * Deliberately a strict allow-list rather than a `javascript:`/`vbscript:`
 * deny-list: the value reaches an `src` attribute, and an allow-list cannot be
 * defeated by a scheme nobody thought to ban. Only `data:` URLs of an ACCEPTED
 * image type pass — `data:text/html` and `data:image/svg+xml` are both
 * script-bearing and are excluded by the same check that bounds the upload.
 */
export function isRenderableThumbnailUrl(value: string | undefined | null): boolean {
  if (typeof value !== 'string') return false;
  const url = value.trim();
  if (!url) return false;
  if (url.startsWith('data:')) {
    return ALLOWED_THUMBNAIL_TYPES.some((type) => url.startsWith(`data:${type};base64,`));
  }
  return /^https?:\/\/\S+$/i.test(url);
}

/**
 * Normalize a stored/pasted value for persistence: returns the trimmed URL, or
 * undefined when there is nothing renderable to store. Callers persist
 * `undefined` as "no thumbnail" so the fallback placeholder is used.
 */
export function normalizeThumbnailUrl(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = value.trim();
  if (!url) return undefined;
  return isRenderableThumbnailUrl(url) ? url : undefined;
}
