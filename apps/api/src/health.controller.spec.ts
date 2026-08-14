import { afterEach, describe, expect, it } from 'vitest';
import { HealthController } from './health.controller';

const original = process.env.SIDESTAGE_SHA;

afterEach(() => {
  if (original === undefined) delete process.env.SIDESTAGE_SHA;
  else process.env.SIDESTAGE_SHA = original;
});

describe('HealthController', () => {
  it('returns the public API health contract', () => {
    process.env.SIDESTAGE_SHA = 'abc123';
    expect(new HealthController().getHealth()).toEqual({
      status: 'ok',
      service: 'sidestage-api',
      version: '0.1.0',
      sha: 'abc123',
    });
  });

  it('reports the sha the image was built from, so .deployed-sha is verifiable', () => {
    process.env.SIDESTAGE_SHA = '6efe685f4b69eb86116e20bf46c474ff72d11717';
    expect(new HealthController().getHealth().sha).toBe(
      '6efe685f4b69eb86116e20bf46c474ff72d11717',
    );
  });

  it("degrades to 'unknown' rather than throwing when the build arg was not passed", () => {
    delete process.env.SIDESTAGE_SHA;
    expect(new HealthController().getHealth().sha).toBe('unknown');
  });

  it("treats an empty SIDESTAGE_SHA as unknown, never as an empty sha", () => {
    // A build arg that defaulted to empty must not be reported as if it were a
    // real sha -- an empty string would compare equal to nothing and read as a
    // silent match failure downstream.
    process.env.SIDESTAGE_SHA = '';
    expect(new HealthController().getHealth().sha).toBe('unknown');
  });
});
