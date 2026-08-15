import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Put,
  UnauthorizedException,
} from '@nestjs/common';
import { EventService } from '../events/event.service';
import { PolicyService } from '../policies/policy.service';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import {
  DEMO_PRINCIPAL_HEADER,
  rolePrincipal,
} from '../sync/sync-request-context';
import { EventConfigService, policyFromConfig, type EventConfig } from './event-config.service';

export function requireSellerPrincipal(value: unknown): string {
  const sellerId = rolePrincipal(value, 'seller');
  if (!sellerId) {
    throw new UnauthorizedException(`${DEMO_PRINCIPAL_HEADER} is required for seller-owned resources.`);
  }
  return sellerId;
}

export async function readEventConfigView(
  configs: EventConfigService,
  policies: PolicyService,
  events: EventService,
  eventId: string,
  sellerId: string,
) {
  if (!await events.findOwned(eventId, sellerId)) {
    throw new NotFoundException('Event not found for this seller.');
  }
  const config = await configs.get(eventId, sellerId);
  const projected = await policies.effectiveCopilotPolicy(sellerId, eventId);
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
  async get(
    @Param('eventId') eventId: string,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
  ) {
    const sellerId = requireSellerPrincipal(principalHeader);
    return readEventConfigView(this.configs, this.policies, this.events, eventId, sellerId);
  }

  @Put(':eventId/config')
  async put(
    @Param('eventId') eventId: string,
    @Body() body: Partial<Omit<EventConfig, 'eventId' | 'updatedAt'>>,
    @Headers(DEMO_PRINCIPAL_HEADER) principalHeader?: string,
    @Headers('x-seller-name') sellerNameHeader?: string,
  ) {
    const sellerId = requireSellerPrincipal(principalHeader);
    // Validate the complete config before creating a directory row, then
    // establish/verify the owned event before writing event_config. This order
    // is required by event_config_event_fk and prevents a rejected payload
    // from leaving behind a partially-created event.
    const config = await this.configs.prepare(eventId, body, sellerId);
    // EI-20426845001666103 / P-014: saving the config IS the seller's
    // create/update act, so the directory row is published here — before this,
    // nothing ever inserted it and a created event was invisible in the buyer
    // Channel Guide (GET /events stayed []) while its direct link worked.
    const sellerName = sellerNameHeader?.trim() || sellerId;
    const published = await this.events.publishFromConfig(config, { sellerId, sellerName });
    if (!published || !await this.configs.persistOwned(config, sellerId)) {
      throw new NotFoundException('Event not found for this seller.');
    }
    const context = { principal: principalHeader };
    this.invalidations.invalidate('event.config', { eventId: config.eventId }, context);
    this.invalidations.invalidate('event.lineup.items', { eventId: config.eventId });
    // The guide is a global directory query. Omitting args invalidates every
    // cached events.guide subscriber; event-scoped args would not match its
    // empty query key and would leave titles/thumbnails stale.
    this.invalidations.invalidate('events.guide');
    this.invalidations.invalidate('events.mine', undefined, context);
    return { ...config, policy: policyFromConfig(config) };
  }
}
