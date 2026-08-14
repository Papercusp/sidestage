import { describe, expect, it } from 'vitest';
import { configPreflightChecks } from './TestTab';

describe('TestTab sync mapping', () => {
  it('derives grounding and approval readiness from the event.config row', () => {
    expect(configPreflightChecks({
      policy: { automationLevel: 'approval-required' },
      guardrails: { priceChanges: true },
    }, false)).toEqual([
      { label: 'Copilot grounding', value: 'Ready', tone: 'success' },
      { label: 'Reply approval', value: 'Required', tone: 'warning' },
    ]);
  });

  it('keeps transport loading distinct from a confirmed unreachable config query', () => {
    expect(configPreflightChecks(null, false)).toEqual([
      { label: 'Copilot grounding', value: 'Checking…', tone: 'muted' },
      { label: 'Reply approval', value: 'Checking…', tone: 'muted' },
    ]);
    expect(configPreflightChecks(null, true)).toEqual([
      { label: 'Copilot grounding', value: 'Unreachable', tone: 'danger' },
      { label: 'Reply approval', value: 'Unknown', tone: 'muted' },
    ]);
  });
});
