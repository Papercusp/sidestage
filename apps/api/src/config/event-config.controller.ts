import { Body, Controller, Get, Headers, Inject, Param, Put } from '@nestjs/common';
import { DEFAULT_SELLER_NAME, EventService } from '../events/event.service';
import { DEFAULT_SELLER_ID, PolicyService } from '../policies/policy.service';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { EventConfigService, policyFromConfig, type EventConfig } from './event-config.service';

export async function readEventConfigView(
  configs: EventConfigService,
  policies: PolicyService,
  eventId: string,
) {
  const config = await configs.get(eventId);
  const projected = await policies.effectiveCopilotPolicy(DEFAULT_SELLER_ID, eventId);
  if (projected) {
    return {
      ...config,
      policy: projected.policy,
      policySource: projected.effective.source,
      policyRevisionId: projected.effective.policyRevisionId,
      policyFingerprint: projected.effective.policyFingerprint,
    };
  }
  return { ...config, policy: policyFromConfig(config), policySource: 'config-toggle' };
}

@Controller('events')
export class EventConfigController {
  constructor(
    @Inject(EventConfigService) private readonly configs: EventConfigService,
    @Inject(PolicyService) private readonly policies: PolicyService,
    @Inject(SyncInvalidationService) private readonly invalidations: SyncInvalidationService,
    @Inject(EventService) private readonly events: EventService,
  ) {}

  /**
   * P-114: a PUBLISHED seller policy (event scope > seller-wide) supplies the
   * copilot policy — the guardrail-toggle derivation stays the fallback when
   * nothing is published. The response names its source + revision metadata so
   * the Config tab can show inherited-vs-event-specific terms.
   */
  @Get(':eventId/config')
  async get(@Param('eventId') eventId: string) {
    return readEventConfigView(this.configs, this.policies, eventId);
  }

  @Put(':eventId/config')
  async put(
    @Param('eventId') eventId: string,
    @Body() body: Partial<Omit<EventConfig, 'eventId' | 'updatedAt'>>,
    @Headers('x-seller-id') sellerIdHeader?: string,
    @Headers('x-seller-name') sellerNameHeader?: string,
  ) {
    const config = await this.configs.save(eventId, body);
    // EI-20426845001666103 / P-014: saving the config IS the seller's
    // create/update act, so the directory row is published here — before this,
    // nothing ever inserted it and a created event was invisible in the buyer
    // Channel Guide (GET /events stayed []) while its direct link worked.
    const sellerId = sellerIdHeader?.trim() || DEFAULT_SELLER_ID;
    const sellerName = sellerNameHeader?.trim()
      || (sellerId === DEFAULT_SELLER_ID ? DEFAULT_SELLER_NAME : sellerId);
    await this.events.publishFromConfig(config, { sellerId, sellerName });
    this.invalidations.invalidate('event.config', { eventId: config.eventId });
    // The guide is a global directory query. Omitting args invalidates every
    // cached events.guide subscriber; event-scoped args would not match its
    // empty query key and would leave titles/thumbnails stale.
    this.invalidations.invalidate('events.guide');
    this.invalidations.invalidate('events.mine');
    return { ...config, policy: policyFromConfig(config) };
  }
}
