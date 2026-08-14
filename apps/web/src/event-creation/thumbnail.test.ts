import { describe, expect, it } from 'vitest';
import {
  ALLOWED_THUMBNAIL_TYPES,
  MAX_THUMBNAIL_BYTES,
  isRenderableThumbnailUrl,
  normalizeThumbnailUrl,
  readThumbnailFile,
  validateThumbnailFile,
  type ThumbnailFileLike,
} from './thumbnail';

function fileLike(type: string, bytes: Uint8Array | number): ThumbnailFileLike {
  const data = typeof bytes === 'number' ? new Uint8Array(bytes) : bytes;
  return {
    type,
    size: typeof bytes === 'number' ? bytes : data.length,
    async arrayBuffer() {
      // Return a copy so a caller cannot mutate the fixture's backing buffer.
      return data.slice().buffer;
    },
  };
}

describe('validateThumbnailFile', () => {
  it('accepts every allowed image type', () => {
    for (const type of ALLOWED_THUMBNAIL_TYPES) {
      expect(validateThumbnailFile(fileLike(type, 1024))).toEqual({ ok: true });
    }
  });

  it('rejects a non-image type and names the accepted formats', () => {
    const result = validateThumbnailFile(fileLike('application/pdf', 1024));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toMatch(/JPEG, PNG, WebP, or GIF/);
  });

  it('rejects an SVG even though it is an image', () => {
    // SVG can carry script; it is excluded from the allow-list on purpose.
    expect(validateThumbnailFile(fileLike('image/svg+xml', 1024)).ok).toBe(false);
  });

  it('rejects a file the browser gave no type for', () => {
    expect(validateThumbnailFile(fileLike('', 1024)).ok).toBe(false);
  });

  it('rejects an empty file', () => {
    expect(validateThumbnailFile(fileLike('image/png', 0)).ok).toBe(false);
  });

  it('accepts a file exactly at the cap and rejects one byte over', () => {
    expect(validateThumbnailFile(fileLike('image/png', MAX_THUMBNAIL_BYTES))).toEqual({ ok: true });
    const over = validateThumbnailFile(fileLike('image/png', MAX_THUMBNAIL_BYTES + 1));
    expect(over.ok).toBe(false);
    // The message should tell the seller both the limit and what they picked.
    expect(over.ok === false && over.error).toMatch(/512KB or smaller/);
  });
});

describe('readThumbnailFile', () => {
  it('encodes an accepted file as a data URL of the same media type', async () => {
    const result = await readThumbnailFile(fileLike('image/png', new Uint8Array([1, 2, 3, 4])));
    expect(result.ok).toBe(true);
    expect(result.ok === true && result.dataUrl).toBe('data:image/png;base64,AQIDBA==');
  });

  it('round-trips the exact bytes', async () => {
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
    const result = await readThumbnailFile(fileLike('image/jpeg', bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const base64 = result.dataUrl.slice('data:image/jpeg;base64,'.length);
    expect(Uint8Array.from(Buffer.from(base64, 'base64'))).toEqual(bytes);
  });

  it('encodes a file larger than one spread chunk without blowing the stack', async () => {
    // Guards the chunked base64 loop: a single String.fromCharCode(...bytes)
    // over this many args throws RangeError in V8.
    const bytes = new Uint8Array(200_000).fill(7);
    const result = await readThumbnailFile(fileLike('image/webp', bytes));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const base64 = result.dataUrl.slice('data:image/webp;base64,'.length);
    expect(Buffer.from(base64, 'base64').length).toBe(bytes.length);
  });

  it('does not read the bytes of a file that fails validation', async () => {
    let read = false;
    const result = await readThumbnailFile({
      type: 'application/zip',
      size: 10,
      async arrayBuffer() {
        read = true;
        return new ArrayBuffer(10);
      },
    });
    expect(result.ok).toBe(false);
    expect(read).toBe(false);
  });

  it('reports a read failure instead of throwing', async () => {
    const result = await readThumbnailFile({
      type: 'image/png',
      size: 10,
      async arrayBuffer() {
        throw new Error('device disconnected');
      },
    });
    expect(result).toEqual({ ok: false, error: 'Could not read that image file.' });
  });

  it('rejects a file that shrinks to nothing between the size check and the read', async () => {
    const result = await readThumbnailFile({
      type: 'image/png',
      size: 1024,
      async arrayBuffer() {
        return new ArrayBuffer(0);
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a file that reports a small size but reads back over the cap', async () => {
    // The size check alone is a claim by the browser; the bytes are the fact.
    const result = await readThumbnailFile({
      type: 'image/png',
      size: 10,
      async arrayBuffer() {
        return new ArrayBuffer(MAX_THUMBNAIL_BYTES + 1);
      },
    });
    expect(result.ok).toBe(false);
  });
});

describe('isRenderableThumbnailUrl', () => {
  it('accepts data URLs of the allowed image types', () => {
    for (const type of ALLOWED_THUMBNAIL_TYPES) {
      expect(isRenderableThumbnailUrl(`data:${type};base64,AQID`)).toBe(true);
    }
  });

  it('accepts http and https URLs', () => {
    expect(isRenderableThumbnailUrl('https://cdn.example/a.png')).toBe(true);
    expect(isRenderableThumbnailUrl('http://cdn.example/a.png')).toBe(true);
  });

  it('rejects script-bearing data URLs that would otherwise reach an img src', () => {
    // These are the reason this is an allow-list and not a deny-list.
    expect(isRenderableThumbnailUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBe(false);
    expect(isRenderableThumbnailUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe(false);
    expect(isRenderableThumbnailUrl('javascript:alert(1)')).toBe(false);
    expect(isRenderableThumbnailUrl('JavaScript:alert(1)')).toBe(false);
    expect(isRenderableThumbnailUrl('vbscript:msgbox(1)')).toBe(false);
  });

  it('rejects a data URL that only looks like an allowed type', () => {
    expect(isRenderableThumbnailUrl('data:image/png,notbase64')).toBe(false);
    expect(isRenderableThumbnailUrl('data:image/pngX;base64,AQID')).toBe(false);
  });

  it('rejects empty, blank, and non-string values', () => {
    expect(isRenderableThumbnailUrl('')).toBe(false);
    expect(isRenderableThumbnailUrl('   ')).toBe(false);
    expect(isRenderableThumbnailUrl(undefined)).toBe(false);
    expect(isRenderableThumbnailUrl(null)).toBe(false);
  });
});

describe('normalizeThumbnailUrl', () => {
  it('trims a renderable URL', () => {
    expect(normalizeThumbnailUrl('  https://cdn.example/a.png  ')).toBe('https://cdn.example/a.png');
  });

  it('drops anything not renderable so the fallback placeholder is used', () => {
    expect(normalizeThumbnailUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeThumbnailUrl('')).toBeUndefined();
    expect(normalizeThumbnailUrl(undefined)).toBeUndefined();
  });
});
