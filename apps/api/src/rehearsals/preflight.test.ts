import { describe, expect, it } from 'vitest';
import { defaultEventConfig, policyFromConfig, type EventConfig } from '../config/event-config.service';
import type { CopilotPolicy } from '../copilot/copilot.types';
import {
  buildPreflightReport,
  lintDurability,
  lintEventConfig,
  lintPricingPolicy,
} from './preflight';

const savedConfig: EventConfig = {
  eventId: 'sunday-drop',
  name: 'Autumn glaze drop',
  replyTone: 'warm',
  guardrails: { priceChanges: true, inventoryClaims: true, buyerSensitive: true },
  updatedAt: '2026-08-13T12:00:00.000Z',
};

const guardedPolicy: CopilotPolicy = {
  automationLevel: 'confirm',
  allowAutoActions: false,
  priceFloorCentsByProduct: { 'aurora-cup': 2_000 },
  maxMarkdownPercent: 30,
  blockedActionKinds: [],
  tone: 'warm',
};

const statusOf = (checks: { id: string; status: string }[], id: string) => checks.find((check) => check.id === id)?.status;

describe('pricing policy lint', () => {
  it('blocks a launch when no price floor is configured', () => {
    const checks = lintPricingPolicy({ ...guardedPolicy, priceFloorCentsByProduct: {} });
    expect(statusOf(checks, 'price-floors')).toBe('blocker');
    expect(checks.find((check) => check.id === 'price-floors')?.remedy).toContain('price floor');
  });

  it('passes when floors are configured', () => {
    expect(statusOf(lintPricingPolicy(guardedPolicy), 'price-floors')).toBe('ready');
  });

  it('warns when the discount cap is no cap at all', () => {
    expect(statusOf(lintPricingPolicy({ ...guardedPolicy, maxMarkdownPercent: 100 }), 'markdown-cap')).toBe('warning');
    expect(statusOf(lintPricingPolicy(guardedPolicy), 'markdown-cap')).toBe('ready');
  });

  it('warns when the copilot can act without confirmation', () => {
    expect(statusOf(
      lintPricingPolicy({ ...guardedPolicy, automationLevel: 'auto', allowAutoActions: true }),
      'automation-level',
    )).toBe('warning');
    expect(statusOf(lintPricingPolicy(guardedPolicy), 'automation-level')).toBe('ready');
  });
});

describe('the lint against the policy the Config tab actually produces', () => {
  // This pins WI-38673 to the code. policyFromConfig currently emits an empty
  // price-floor map, so the guard refuses every price-bearing action. If that
  // is fixed, this test fails and forces the expectation to be updated with it
  // — which is the point: the finding must not quietly rot into folklore.
  it('reports a BLOCKER for a config-derived policy, guardrails on', () => {
    const policy = policyFromConfig(savedConfig);
    expect(policy.priceFloorCentsByProduct).toEqual({});
    expect(statusOf(lintPricingPolicy(policy), 'price-floors')).toBe('blocker');
  });

  it('reports a blocker AND an uncapped-discount warning with guardrails off', () => {
    const policy = policyFromConfig({ ...savedConfig, guardrails: { priceChanges: false, inventoryClaims: true, buyerSensitive: true } });
    const checks = lintPricingPolicy(policy);
    expect(statusOf(checks, 'price-floors')).toBe('blocker');
    expect(statusOf(checks, 'markdown-cap')).toBe('warning');
    expect(statusOf(checks, 'automation-level')).toBe('warning');
  });
});

describe('event config lint', () => {
  it('warns when the event is still running on untouched defaults', () => {
    const checks = lintEventConfig(defaultEventConfig('sunday-drop'));
    expect(statusOf(checks, 'config-saved')).toBe('warning');
    expect(checks.find((check) => check.id === 'config-saved')?.detail).toContain('Sunday vintage drop');
  });

  it('passes once the host has saved their own setup', () => {
    const checks = lintEventConfig(savedConfig);
    expect(statusOf(checks, 'config-saved')).toBe('ready');
    expect(checks.find((check) => check.id === 'config-saved')?.detail).toContain('Autumn glaze drop');
  });

  it('names exactly which always-ask guardrails are switched off', () => {
    const checks = lintEventConfig({
      ...savedConfig,
      guardrails: { priceChanges: false, inventoryClaims: true, buyerSensitive: false },
    });
    const detail = checks.find((check) => check.id === 'guardrails')?.detail ?? '';
    expect(detail).toContain('price changes');
    expect(detail).toContain('buyer-sensitive topics');
    expect(detail).not.toContain('inventory claims');
  });
});

describe('durability lint', () => {
  it('warns when there is no database behind the API', () => {
    expect(lintDurability(false).status).toBe('warning');
    expect(lintDurability(false).detail).toContain('lost if the API restarts');
    expect(lintDurability(true).status).toBe('ready');
  });
});

describe('preflight report', () => {
  it('is not ready when anything blocks, and counts what is wrong', () => {
    const report = buildPreflightReport({
      eventId: 'sunday-drop',
      config: defaultEventConfig('sunday-drop'),
      policy: policyFromConfig(defaultEventConfig('sunday-drop')),
      hasDatabase: false,
      now: () => 1_700_000_000_000,
    });
    expect(report.ready).toBe(false);
    expect(report.blockers).toBeGreaterThan(0);
    expect(report.warnings).toBeGreaterThan(0);
    expect(report.ranAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(report.eventId).toBe('sunday-drop');
  });

  it('is ready when a fully configured event has no blockers', () => {
    const report = buildPreflightReport({
      eventId: 'sunday-drop',
      config: savedConfig,
      policy: guardedPolicy,
      hasDatabase: true,
      now: () => 1,
    });
    expect(report.ready).toBe(true);
    expect(report.blockers).toBe(0);
    expect(report.warnings).toBe(0);
    expect(report.checks.every((check) => check.status === 'ready')).toBe(true);
  });

  it('gives every non-ready check something to do about it', () => {
    const report = buildPreflightReport({
      eventId: 'sunday-drop',
      config: defaultEventConfig('sunday-drop'),
      policy: policyFromConfig(defaultEventConfig('sunday-drop')),
      hasDatabase: false,
    });
    for (const check of report.checks.filter((entry) => entry.status !== 'ready')) {
      expect(check.remedy, `${check.id} has no remedy`).toBeTruthy();
    }
  });
});
