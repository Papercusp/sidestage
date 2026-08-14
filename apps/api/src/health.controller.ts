import { Controller, Get } from '@nestjs/common';

export type HealthResponse = {
  status: 'ok';
  service: 'sidestage-api';
  version: string;
  /**
   * The git sha this image was built from, baked in at build time
   * (Dockerfile ARG SIDESTAGE_SHA -> ENV). 'unknown' outside a tagged build.
   *
   * This exists so /opt/SideStage/.deployed-sha can be VERIFIED against what
   * is actually running rather than trusted: the file is an assertion written
   * by the deployer, this is a measurement taken from the running process.
   */
  sha: string;
};

@Controller()
export class HealthController {
  @Get('healthz')
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'sidestage-api',
      version: '0.1.0',
      sha: process.env.SIDESTAGE_SHA || 'unknown',
    };
  }
}
