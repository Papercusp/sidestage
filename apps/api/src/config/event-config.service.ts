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
  /**
   * Thumbnail shown for this event in buyer-facing listings. Either a `data:`
   * URL (a seller upload, inlined — SideStage has no object store; the
   * "media base" is MediaMTX, a live-video endpoint that stores nothing) or an
   * ordinary `https:` URL. One field for both so no renderer branches on
   * provenance, and so moving to real object storage later changes only what
   * the uploader produces. Absent means the caller renders its placeholder.
   */
  thumbnailUrl?: string;
  replyTone: ReplyTone;
  guardrails: EventGuardrails;
  updatedAt: string;
}

export interface EventConfigStore {
  get(eventId: string, sellerId?: string): Promise<EventConfig | undefined>;
  set(config: EventConfig, sellerId?: string): Promise<boolean>;
}

@Injectable()
export class InMemoryEventConfigStore implements EventConfigStore {
  private readonly configs = new Map<string, { config: EventConfig; sellerId?: string }>();

  async get(eventId: string, sellerId?: string): Promise<EventConfig | undefined> {
    const stored = this.configs.get(eventId);
    if (!stored) return undefined;
    if (sellerId && stored.sellerId !== sellerId) return undefined;
    return stored.config;
  }

  async set(config: EventConfig, sellerId?: string): Promise<boolean> {
    const stored = this.configs.get(config.eventId);
    if (sellerId && stored?.sellerId && stored.sellerId !== sellerId) return false;
    this.configs.set(config.eventId, {
      config,
      ...(stored?.sellerId || sellerId ? { sellerId: stored?.sellerId ?? sellerId } : {}),
    });
    return true;
  }
}

export class PgEventConfigStore implements EventConfigStore {
  constructor(private readonly pool: Pool) {}

  async get(eventId: string, sellerId?: string): Promise<EventConfig | undefined> {
    const result = await this.pool.query<{ payload: EventConfig }>(
      sellerId
        ? `SELECT config.payload
             FROM event_config AS config
             JOIN event AS owner ON owner.event_id = config.event_id
            WHERE config.event_id = $1
              AND owner.seller_id = $2`
        : 'SELECT payload FROM event_config WHERE event_id = $1',
      sellerId ? [eventId, sellerId] : [eventId],
    );
    return result.rows[0]?.payload ?? undefined;
  }

  async set(config: EventConfig, sellerId?: string): Promise<boolean> {
    const result = await this.pool.query<{ event_id: string }>(
      sellerId
        ? `INSERT INTO event_config (event_id, payload, updated_at)
           SELECT owner.event_id, $2::jsonb, now()
             FROM event AS owner
            WHERE owner.event_id = $1
              AND owner.seller_id = $3
           ON CONFLICT (event_id) DO UPDATE
             SET payload = EXCLUDED.payload, updated_at = now()
           RETURNING event_id`
        : `INSERT INTO event_config (event_id, payload, updated_at) VALUES ($1, $2::jsonb, now())
           ON CONFLICT (event_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()
           RETURNING event_id`,
      sellerId
        ? [config.eventId, JSON.stringify(config), sellerId]
        : [config.eventId, JSON.stringify(config)],
    );
    return result.rows.length > 0;
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

/** Raster image types accepted for an event thumbnail. SVG is excluded on purpose: it can carry script. */
const ALLOWED_THUMBNAIL_MEDIA_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Character cap on a stored thumbnail URL. The uploader bounds the RAW file at
 * 512KB; base64 inflates by ~4/3, so ~700K characters is that same bound
 * expressed in what actually lands in the jsonb payload. This is the check that
 * stops an oversized data URL from bloating every read of the event config.
 */
const MAX_THUMBNAIL_URL_CHARS = 700_000;

/**
 * The guardrail toggle IS the policy (P-105): the saved config derives the
 * CopilotPolicy the action guard enforces. Price guardrail ON keeps markdowns
 * inside the conservative bound and every action at confirm-level; OFF lets
 * the seller cut freely with auto actions. Reply tone maps onto the copilot's
 * tone vocabulary.
 */
export function policyFromConfig(config: EventConfig): CopilotPolicy {
  const guarded = config.guardrails.priceChanges;
  // WI-38815: the always-ask toggles now reach the action boundary. Each ON
  // toggle caps its action kinds at 'confirm' in the copilot pipeline —
  // buyer-sensitive covers buyer-directed offers; inventory claims cover the
  // kinds that assert stock. Before this, the toggles were stored and rendered
  // in preflight copy but never enforced.
  const alwaysConfirmActionKinds = [
    ...(config.guardrails.buyerSensitive ? (['targeted-offer'] as const) : []),
    ...(config.guardrails.inventoryClaims ? (['stock-adjust', 'swap'] as const) : []),
  ];
  return {
    automationLevel: guarded ? 'confirm' : 'auto',
    allowAutoActions: !guarded,
    maxMarkdownPercent: guarded ? 30 : 100,
    priceFloorCentsByProduct: {},
    blockedActionKinds: [],
    tone: config.replyTone === 'minimal' ? 'concise' : config.replyTone === 'playful' ? 'warm' : 'warm',
    ...(alwaysConfirmActionKinds.length > 0 ? { alwaysConfirmActionKinds } : {}),
  };
}

/**
 * Fills in the per-product price floors PolicyActionGuard requires (WI-38673).
 * A floor the policy already names (a published policy document, P-114) always
 * wins; a product with no explicit floor derives one from its verified event
 * price and the policy's markdown cap, so "guardrails: on" yields guarded
 * discounting instead of the guard's blanket "no floor configured" refusal.
 * Mirrors the client-side derivation in apps/web/src/events/api.ts
 * (policyWithVerifiedFloors) so preview and enforcement agree.
 */
export function withDerivedPriceFloors(
  policy: CopilotPolicy,
  items: readonly { productId: string; priceCents: number }[],
): CopilotPolicy {
  const floors: Record<string, number> = { ...policy.priceFloorCentsByProduct };
  for (const item of items) {
    if (Number.isSafeInteger(floors[item.productId])) continue;
    if (!Number.isSafeInteger(item.priceCents) || item.priceCents <= 0) continue;
    floors[item.productId] = Math.max(1, Math.ceil(item.priceCents * (1 - policy.maxMarkdownPercent / 100)));
  }
  return { ...policy, priceFloorCentsByProduct: floors };
}

@Injectable()
export class EventConfigService {
  constructor(@Inject(EVENT_CONFIG_STORE) private readonly store: EventConfigStore) {}

  async get(eventId: string, sellerId?: string): Promise<EventConfig> {
    const id = this.readEventId(eventId);
    return (await this.store.get(id, sellerId)) ?? defaultEventConfig(id);
  }

  async save(eventId: string, input: Partial<Omit<EventConfig, 'eventId' | 'updatedAt'>>): Promise<EventConfig> {
    const next = await this.prepare(eventId, input);
    await this.store.set(next);
    return next;
  }

  /** Validate and merge without writing, so callers can establish the event FK first. */
  async prepare(
    eventId: string,
    input: Partial<Omit<EventConfig, 'eventId' | 'updatedAt'>>,
    sellerId?: string,
  ): Promise<EventConfig> {
    const id = this.readEventId(eventId);
    const current = await this.get(id, sellerId);
    // `thumbnailUrl` is tri-state on the way in: absent => keep what is stored,
    // explicit null/'' => clear it, a string => validate and replace. Without
    // the null case a seller could never REMOVE a thumbnail once set, because
    // `input.x ?? current.x` reads every falsy clear as "unchanged".
    const thumbnailInput = 'thumbnailUrl' in input ? input.thumbnailUrl : current.thumbnailUrl;
    const next: EventConfig = {
      eventId: id,
      name: this.readName(input.name ?? current.name),
      thumbnailUrl: this.readThumbnailUrl(thumbnailInput),
      replyTone: this.readTone(input.replyTone ?? current.replyTone),
      guardrails: {
        priceChanges: input.guardrails?.priceChanges ?? current.guardrails.priceChanges,
        inventoryClaims: input.guardrails?.inventoryClaims ?? current.guardrails.inventoryClaims,
        buyerSensitive: input.guardrails?.buyerSensitive ?? current.guardrails.buyerSensitive,
      },
      updatedAt: new Date().toISOString(),
    };
    return next;
  }

  /** Owner-scoped write; false collapses a foreign and absent event to one result. */
  async persistOwned(config: EventConfig, sellerId: string): Promise<boolean> {
    return this.store.set(config, sellerId);
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

  /**
   * Validate a thumbnail URL server-side.
   *
   * This deliberately RE-IMPLEMENTS the browser's check rather than sharing it.
   * The client-side validator in apps/web guides the seller; this one is a
   * trust boundary, and a trust boundary that imports its rule from the thing
   * it distrusts is not one. The value ends up in an `<img src>` for every
   * buyer, so the scheme check is an ALLOW-list: only `data:` URLs of a known
   * raster image type, or http(s). `data:image/svg+xml` and `data:text/html`
   * are script-bearing and are excluded here, not merely discouraged.
   */
  private readThumbnailUrl(value: unknown): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') throw new BadRequestException('thumbnailUrl must be a string');
    const url = value.trim();
    if (!url) return undefined;
    if (url.length > MAX_THUMBNAIL_URL_CHARS) {
      throw new BadRequestException(
        `thumbnailUrl must be ${MAX_THUMBNAIL_URL_CHARS} characters or fewer (an image around 512KB once base64-encoded)`,
      );
    }
    const isDataImage = ALLOWED_THUMBNAIL_MEDIA_TYPES.some((type) => url.startsWith(`data:${type};base64,`));
    if (isDataImage || /^https?:\/\/\S+$/i.test(url)) return url;
    throw new BadRequestException(
      'thumbnailUrl must be an http(s) URL or a base64 data URL of a JPEG, PNG, WebP, or GIF image',
    );
  }

  private readTone(value: string): ReplyTone {
    if (!REPLY_TONES.has(value as ReplyTone)) throw new BadRequestException('replyTone must be warm, playful, or minimal');
    return value as ReplyTone;
  }
}
