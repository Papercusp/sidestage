import { describe, expect, it } from 'vitest';

import {
  canTransitionSystemTestRun,
  redactSystemTestJson,
  redactSystemTestText,
} from './postgres-run-store';

describe('system-test run state machine', () => {
  it('allows the forward execution path and treats repeats as idempotent', () => {
    expect(canTransitionSystemTestRun('queued', 'queued')).toBe(true);
    expect(canTransitionSystemTestRun('queued', 'provisioning')).toBe(true);
    expect(canTransitionSystemTestRun('provisioning', 'running')).toBe(true);
    expect(canTransitionSystemTestRun('running', 'collecting')).toBe(true);
    expect(canTransitionSystemTestRun('collecting', 'cleaning')).toBe(true);
    expect(canTransitionSystemTestRun('cleaning', 'passed')).toBe(true);
  });

  it('refuses regressions while allowing cleanup failure to override any outcome', () => {
    expect(canTransitionSystemTestRun('running', 'queued')).toBe(false);
    expect(canTransitionSystemTestRun('passed', 'running')).toBe(false);
    expect(canTransitionSystemTestRun('failed', 'passed')).toBe(false);
    expect(canTransitionSystemTestRun('passed', 'cleanup-failed')).toBe(true);
    expect(canTransitionSystemTestRun('timed-out', 'cleanup-failed')).toBe(true);
    expect(canTransitionSystemTestRun('cleanup-failed', 'passed')).toBe(false);
  });
});

describe('system-test persistence redaction', () => {
  it('removes URL credentials, query secrets, bearer tokens, and labelled secrets', () => {
    const raw = [
      'https://operator:password@example.test/artifact.json?token=secret#frag',
      'Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
      'api_key=square-secret',
    ].join(' ');
    const redacted = redactSystemTestText(raw);

    expect(redacted).toContain('https://example.test/artifact.json');
    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).toContain('api_key=[REDACTED]');
    expect(redacted).not.toContain('operator');
    expect(redacted).not.toContain('square-secret');
    expect(redacted).not.toContain('payload.signature');
    expect(redacted).not.toContain('?token=');
  });

  it('redacts credential-shaped JSON fields recursively without losing evidence shape', () => {
    expect(redactSystemTestJson({
      service: 'square',
      config: { accessToken: 'secret-value', endpoint: 'https://api.example.test/v2?key=secret' },
    })).toEqual({
      service: 'square',
      config: { accessToken: '[REDACTED]', endpoint: 'https://api.example.test/v2' },
    });
  });
});
