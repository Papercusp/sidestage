import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { CopilotPolicy } from '../copilot/copilot.types';

export const EVENT_CONFIG_STORE = Symbol('EVENT_CONFIG_STORE');

export interface EventGuardrails {
  /** Always ask before sending a price change (no invented discounts/bundles). */
  priceChanges: boolean;
  /** Inventory claims must use the latest catalog quantity. */
  inventoryClaims: boolean;
  /** Uncertain replies on buyer-sensitive topics stay in review. */
  buyerSensitive: boolean;
}

export type ReplyTone = 'warm' | 'playful' | 'minimal';

export interface EventConfig {
  eventId: string;
  name: string;
  replyTone: ReplyTone;
  guardrails: EventGuardrails;
  updatedAt: string;
}

export interface EventConfigStore {
  get(eventId: string): Promise<EventConfig | undefined>;
  set(config: EventConfig): Promise<void>;
}

@Injectable()
export class InMemoryEventConfigStore implements EventConfigStore {
  private readonly configs = new Map<string, EventConfig>();

  async get(eventId: string): Promise<EventConfig | undefined> {
    return this.configs.get(eventId);
  }

  async set(config: EventConfig): Promise<void> {
    this.configs.set(config.eventId, config);
  }
}

export class PgEventConfigStore implements EventConfigStore {
  constructor(private readonly pool: Pool) {}

  async get(eventId: string): Promise<EventConfig | undefined> {
    const result = await this.pool.query<{ payload: EventConfig }>(
      'SELECT payload FROM event_config WHERE event_id = $1',
      [eventId],
    );
    return result.rows[0]?.payload ?? undefined;
  }

  async set(config: EventConfig): Promise<void> {
    await this.pool.query(
      `INSERT INTO event_config (event_id, payload, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (event_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
      [config.eventId, JSON.stringify(config)],
    );
  }
}

export function defaultEventConfig(eventId: string): EventConfig {
  return {
    eventId,
    name: 'Sunday vintage drop',
    replyTone: 'warm',
    guardrails: { priceChanges: true, inventoryClaims: true, buyerSensitive: true },
    updatedAt: new Date(0).toISOString(),
  };
}

const REPLY_TONES = new Set<ReplyTone>(['warm', 'playful', 'minimal']);

/**
 * The guardrail toggle IS the policy (P-105): the saved config derives the
 * CopilotPolicy the action guard enforces. Price guardrail ON keeps markdowns
 * inside the conservative bound and every action at confirm-level; OFF lets
 * the seller cut freely with auto actions. Reply tone maps onto the copilot's
 * tone vocabulary.
 */
export function policyFromConfig(config: EventConfig): CopilotPolicy {
  const guarded = config.guardrails.priceChanges;
  return {
    automationLevel: guarded ? 'confirm' : 'auto',
    allowAutoActions: !guarded,
    maxMarkdownPercent: guarded ? 30 : 100,
    priceFloorCentsByProduct: {},
    blockedActionKinds: [],
    tone: config.replyTone === 'minimal' ? 'concise' : config.replyTone === 'playful' ? 'warm' : 'warm',
  };
}

@Injectable()
export class EventConfigService {
  constructor(@Inject(EVENT_CONFIG_STORE) private readonly store: EventConfigStore) {}

  async get(eventId: string): Promise<EventConfig> {
    const id = this.readEventId(eventId);
    return (await this.store.get(id)) ?? defaultEventConfig(id);
  }

  async save(eventId: string, input: Partial<Omit<EventConfig, 'eventId' | 'updatedAt'>>): Promise<EventConfig> {
    const id = this.readEventId(eventId);
    const current = await this.get(id);
    const next: EventConfig = {
      eventId: id,
      name: this.readName(input.name ?? current.name),
      replyTone: this.readTone(input.replyTone ?? current.replyTone),
      guardrails: {
        priceChanges: input.guardrails?.priceChanges ?? current.guardrails.priceChanges,
        inventoryClaims: input.guardrails?.inventoryClaims ?? current.guardrails.inventoryClaims,
        buyerSensitive: input.guardrails?.buyerSensitive ?? current.guardrails.buyerSensitive,
      },
      updatedAt: new Date().toISOString(),
    };
    await this.store.set(next);
    return next;
  }

  private readEventId(value: string): string {
    const id = value.trim().toLowerCase();
    if (!id || id.length > 64 || !/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new BadRequestException('eventId must be lowercase letters, numbers, and hyphens');
    }
    return id;
  }

  private readName(value: string): string {
    const name = value.trim();
    if (!name || name.length > 120) throw new BadRequestException('name is required and must be 120 characters or fewer');
    return name;
  }

  private readTone(value: string): ReplyTone {
    if (!REPLY_TONES.has(value as ReplyTone)) throw new BadRequestException('replyTone must be warm, playful, or minimal');
    return value as ReplyTone;
  }
}
