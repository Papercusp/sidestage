import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { DEFAULT_SELLER_ID, PolicyService } from '../policies/policy.service';
import { EventConfigService, policyFromConfig, type EventConfig } from './event-config.service';

@Controller('events')
export class EventConfigController {
  constructor(
    @Inject(EventConfigService) private readonly configs: EventConfigService,
    @Inject(PolicyService) private readonly policies: PolicyService,
  ) {}

  /**
   * P-114: a PUBLISHED seller policy (event scope > seller-wide) supplies the
   * copilot policy — the guardrail-toggle derivation stays the fallback when
   * nothing is published. The response names its source + revision metadata so
   * the Config tab can show inherited-vs-event-specific terms.
   */
  @Get(':eventId/config')
  async get(@Param('eventId') eventId: string) {
    const config = await this.configs.get(eventId);
    const projected = await this.policies.effectiveCopilotPolicy(DEFAULT_SELLER_ID, eventId);
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

  @Put(':eventId/config')
  async put(
    @Param('eventId') eventId: string,
    @Body() body: Partial<Omit<EventConfig, 'eventId' | 'updatedAt'>>,
  ) {
    const config = await this.configs.save(eventId, body);
    return { ...config, policy: policyFromConfig(config) };
  }
}
