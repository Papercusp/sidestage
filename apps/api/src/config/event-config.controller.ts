import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { EventConfigService, policyFromConfig, type EventConfig } from './event-config.service';

@Controller('events')
export class EventConfigController {
  constructor(@Inject(EventConfigService) private readonly configs: EventConfigService) {}

  @Get(':eventId/config')
  async get(@Param('eventId') eventId: string) {
    const config = await this.configs.get(eventId);
    return { ...config, policy: policyFromConfig(config) };
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
