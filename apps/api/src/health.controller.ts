import { Controller, Get } from '@nestjs/common';

export type HealthResponse = {
  status: 'ok';
  service: 'sidestage-api';
  version: string;
};

@Controller()
export class HealthController {
  @Get('healthz')
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'sidestage-api',
      version: '0.1.0',
    };
  }
}
