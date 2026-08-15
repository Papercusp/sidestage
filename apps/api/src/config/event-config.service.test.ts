import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  EventConfigService,
  InMemoryEventConfigStore,
  defaultEventConfig,
  policyFromConfig,
  type EventConfig,
} from './event-config.service';

const EVENT_ID = 'demo-event';

/** A minimal but structurally-valid base64 data URL of each accepted type. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUg==';

function service(): { svc: EventConfigService; store: InMemoryEventConfigStore } {
  const store = new InMemoryEventConfigStore();
  return { svc: new EventConfigService(store), store };
}

async function saved(svc: EventConfigService): Promise<EventConfig> {
  return svc.get(EVENT_ID);
}

describe('EventConfigService thumbnailUrl validation', () => {
  let svc: EventConfigService;

  beforeEach(() => {
    svc = service().svc;
  });

  it('defaults to no thumbnail', async () => {
    const config = await svc.get(EVENT_ID);
    expect(config.thumbnailUrl).toBeUndefined();
    expect(defaultEventConfig(EVENT_ID).thumbnailUrl).toBeUndefined();
  });

  describe('accepts', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif']) {
      it(`a base64 data URL of ${type}`, async () => {
        const url = `data:${type};base64,${PIXEL}`;
        const config = await svc.save(EVENT_ID, { thumbnailUrl: url });
        expect(config.thumbnailUrl).toBe(url);
        expect((await saved(svc)).thumbnailUrl).toBe(url);
      });
    }

    it('an https URL', async () => {
      const url = 'https://cdn.example.com/event/thumb.jpg';
      expect((await svc.save(EVENT_ID, { thumbnailUrl: url })).thumbnailUrl).toBe(url);
    });

    it('an http URL', async () => {
      const url = 'http://cdn.example.com/event/thumb.jpg';
      expect((await svc.save(EVENT_ID, { thumbnailUrl: url })).thumbnailUrl).toBe(url);
    });

    it('trims surrounding whitespace before storing', async () => {
      const url = `data:image/png;base64,${PIXEL}`;
      expect((await svc.save(EVENT_ID, { thumbnailUrl: `  ${url}  ` })).thumbnailUrl).toBe(url);
    });

    it('a data URL exactly at the character cap', async () => {
      const prefix = 'data:image/png;base64,';
      const url = prefix + 'A'.repeat(700_000 - prefix.length);
      expect(url).toHaveLength(700_000);
      expect((await svc.save(EVENT_ID, { thumbnailUrl: url })).thumbnailUrl).toHaveLength(700_000);
    });
  });

  describe('rejects', () => {
    // The value lands in an <img src> for every buyer, so the scheme check is an
    // ALLOW-list. These are the script-bearing shapes that a deny-list misses.
    const rejected: Array<[string, unknown]> = [
      ['an SVG data URL (can carry script)', `data:image/svg+xml;base64,${PIXEL}`],
      ['an HTML data URL', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
      ['a plain-text data URL', 'data:text/plain;base64,aGVsbG8='],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a data URL that is not base64-encoded', 'data:image/png,notbase64'],
      ['an image data URL with a leading scheme-confusing prefix', ` javascript:data:image/png;base64,${PIXEL}`],
      ['a bare file path', '/var/tmp/thumb.png'],
      ['a protocol-relative URL', '//cdn.example.com/thumb.jpg'],
      ['a non-string value', 42],
      ['an object', { url: 'https://example.com/a.png' }],
    ];

    for (const [label, value] of rejected) {
      it(label, async () => {
        await expect(svc.save(EVENT_ID, { thumbnailUrl: value as string })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      });
    }

    it('a data URL one character over the cap', async () => {
      const prefix = 'data:image/png;base64,';
      const url = prefix + 'A'.repeat(700_001 - prefix.length);
      expect(url).toHaveLength(700_001);
      await expect(svc.save(EVENT_ID, { thumbnailUrl: url })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('leaves the stored config untouched when validation fails', async () => {
      const url = `data:image/png;base64,${PIXEL}`;
      await svc.save(EVENT_ID, { thumbnailUrl: url, name: 'Kept name' });
      await expect(svc.save(EVENT_ID, { thumbnailUrl: 'javascript:alert(1)', name: 'Rejected name' })).rejects.toThrow();
      const config = await saved(svc);
      expect(config.thumbnailUrl).toBe(url);
      expect(config.name).toBe('Kept name');
    });
  });

  describe('tri-state merge (absent keeps, null/empty clears, string replaces)', () => {
    const url = `data:image/png;base64,${PIXEL}`;

    it('KEEPS the stored thumbnail when the key is absent', async () => {
      await svc.save(EVENT_ID, { thumbnailUrl: url });
      const config = await svc.save(EVENT_ID, { name: 'Renamed only' });
      expect(config.thumbnailUrl).toBe(url);
      expect(config.name).toBe('Renamed only');
    });

    it('CLEARS the thumbnail on an explicit null', async () => {
      await svc.save(EVENT_ID, { thumbnailUrl: url });
      const config = await svc.save(EVENT_ID, { thumbnailUrl: null as unknown as string });
      expect(config.thumbnailUrl).toBeUndefined();
      expect((await saved(svc)).thumbnailUrl).toBeUndefined();
    });

    it('CLEARS the thumbnail on an explicit empty string', async () => {
      await svc.save(EVENT_ID, { thumbnailUrl: url });
      expect((await svc.save(EVENT_ID, { thumbnailUrl: '' })).thumbnailUrl).toBeUndefined();
    });

    it('CLEARS the thumbnail on a whitespace-only string', async () => {
      await svc.save(EVENT_ID, { thumbnailUrl: url });
      expect((await svc.save(EVENT_ID, { thumbnailUrl: '   ' })).thumbnailUrl).toBeUndefined();
    });

    it('CLEARS the thumbnail on an explicit undefined value for the key', async () => {
      await svc.save(EVENT_ID, { thumbnailUrl: url });
      expect((await svc.save(EVENT_ID, { thumbnailUrl: undefined })).thumbnailUrl).toBeUndefined();
    });

    it('REPLACES one thumbnail with another', async () => {
      await svc.save(EVENT_ID, { thumbnailUrl: url });
      const next = 'https://cdn.example.com/new.png';
      expect((await svc.save(EVENT_ID, { thumbnailUrl: next })).thumbnailUrl).toBe(next);
    });

    it('survives a clear/set cycle', async () => {
      await svc.save(EVENT_ID, { thumbnailUrl: url });
      await svc.save(EVENT_ID, { thumbnailUrl: null as unknown as string });
      expect((await svc.save(EVENT_ID, { thumbnailUrl: url })).thumbnailUrl).toBe(url);
    });
  });

  it('does not disturb the other config fields it merges alongside', async () => {
    const url = `data:image/webp;base64,${PIXEL}`;
    await svc.save(EVENT_ID, { replyTone: 'playful', guardrails: { priceChanges: false, inventoryClaims: true, buyerSensitive: true } });
    const config = await svc.save(EVENT_ID, { thumbnailUrl: url });
    expect(config.replyTone).toBe('playful');
    expect(config.guardrails.priceChanges).toBe(false);
    expect(config.thumbnailUrl).toBe(url);
  });
});

describe('policyFromConfig reply tones', () => {
  it('maps Warm, Playful, and Minimal to three distinct runtime tones', () => {
    const runtimeTones = (['warm', 'playful', 'minimal'] as const).map((replyTone) => (
      policyFromConfig({ ...defaultEventConfig(EVENT_ID), replyTone }).tone
    ));

    expect(runtimeTones).toEqual(['warm', 'playful', 'concise']);
    expect(new Set(runtimeTones).size).toBe(3);
  });
});
