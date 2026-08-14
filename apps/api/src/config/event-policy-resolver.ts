import { Inject, Injectable } from '@nestjs/common';
import type { CopilotPolicy } from '../copilot/copilot.types';
import { DEFAULT_SELLER_ID, PolicyService } from '../policies/policy.service';
import { EventConfigService, policyFromConfig, withDerivedPriceFloors } from './event-config.service';

export const EVENT_POLICY_RESOLVER = Symbol('EVENT_POLICY_RESOLVER');

/** The priced shape the resolver needs from a registered event item. */
export interface PricedEventItem {
  productId: string;
  priceCents: number;
}

/**
 * Resolves the policy the action guard must enforce for an event, at the
 * moment of enforcement. This is the server-side authority WI-38673 found
 * missing: before it, POST /actions/events/:id/register stored whatever
 * policy the request body carried, so the Config tab's guardrail toggles
 * (and P-114 published policies) never reached GuardedActionService.
 *
 * Precedence matches readEventConfigView: a PUBLISHED seller policy wins,
 * the guardrail-toggle derivation is the fallback — then the markdown-cap
 * floor derivation fills any product the policy names no explicit floor for.
 */
export interface EventPolicyResolver {
  resolve(eventId: string, items: readonly PricedEventItem[]): Promise<CopilotPolicy>;
}

@Injectable()
export class ConfigEventPolicyResolver implements EventPolicyResolver {
  constructor(
    @Inject(EventConfigService) private readonly configs: EventConfigService,
    @Inject(PolicyService) private readonly policies: PolicyService,
  ) {}

  async resolve(eventId: string, items: readonly PricedEventItem[]): Promise<CopilotPolicy> {
    const published = await this.policies.effectiveCopilotPolicy(DEFAULT_SELLER_ID, eventId);
    const policy = published ? published.policy : policyFromConfig(await this.configs.get(eventId));
    return withDerivedPriceFloors(policy, items);
  }
}
