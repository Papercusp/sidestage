import { describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('returns the public API health contract', () => {
    expect(new HealthController().getHealth()).toEqual({
      status: 'ok',
      service: 'sidestage-api',
      version: '0.1.0',
    });
  });
});
