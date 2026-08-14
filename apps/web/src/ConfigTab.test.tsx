import { describe, expect, it } from 'vitest';
import { eventConfigUpdate, offlineEventConfig, type EventConfigView } from './ConfigTab';

describe('ConfigTab sync mapping', () => {
  it('maps the named-query row into an update without sending server-owned fields', () => {
    const config: EventConfigView = {
      eventId: 'event-1',
      name: 'Friday drop',
      replyTone: 'playful',
      guardrails: { priceChanges: true, inventoryClaims: false, buyerSensitive: true },
      updatedAt: '2026-08-14T00:00:00.000Z',
    };

    expect(eventConfigUpdate(config)).toEqual({
      name: 'Friday drop',
      replyTone: 'playful',
      guardrails: { priceChanges: true, inventoryClaims: false, buyerSensitive: true },
    });
  });

  it('keeps the existing safe offline defaults when the sync transport is unavailable', () => {
    expect(offlineEventConfig('event-offline')).toMatchObject({
      eventId: 'event-offline',
      replyTone: 'warm',
      guardrails: { priceChanges: true, inventoryClaims: true, buyerSensitive: true },
    });
  });
});
