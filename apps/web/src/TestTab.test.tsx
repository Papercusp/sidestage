import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildLaunchSummary, configPreflightChecks, TEST_SUITE_GROUPS, TestTab } from './TestTab';

const workbenchCss = readFileSync(new URL('./test-workbench.css', import.meta.url), 'utf8');

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

describe('TestTab launch decision', () => {
  it('holds the verdict at not ready until both preflights and the dress rehearsal are green', () => {
    expect(buildLaunchSummary({
      serverPreflight: null,
      clientPreflight: null,
      verdict: null,
    })).toEqual({ ready: false, label: 'Not ready', blockers: 0, unverified: 3 });

    expect(buildLaunchSummary({
      serverPreflight: {
        eventId: 'event-1',
        ranAt: '2026-08-14T12:00:00.000Z',
        ready: true,
        blockers: 0,
        warnings: 0,
        unknowns: 0,
        checks: [],
      },
      clientPreflight: {
        ranAt: '2026-08-14T12:00:01.000Z',
        ready: true,
        blockers: 0,
        warnings: 0,
        unknowns: 0,
        checks: [],
      },
      verdict: {
        ranAt: '2026-08-14T12:00:02.000Z',
        ready: true,
        totalCases: 8,
        passedCases: 8,
        blockers: [],
        caveats: [],
        reports: [],
      },
    })).toEqual({ ready: true, label: 'Ready to go live', blockers: 0, unverified: 0 });
  });

  it('renders the approved compact suite rail while retaining every real rehearsal control', () => {
    const markup = renderToStaticMarkup(<TestTab />);

    expect(TEST_SUITE_GROUPS.map((group) => group.label)).toEqual([
      'Go live',
      'Capabilities',
      'Advanced confidence',
    ]);
    expect(markup).toContain('aria-label="Event rehearsal workbench"');
    expect(markup).toContain('Choose test suite');
    expect(markup).toContain('Required before live');
    expect(markup).toContain('Focused check');
    expect(markup).toContain('Run failed only');
    expect(markup).toContain('Run the full rehearsal');
    expect(markup).toContain('Run load rehearsal');
    expect(markup).toContain('Run judge rehearsal');
    expect(markup).toContain('without sending anything to buyers');
  });

  it('keeps the suite rail persistent on wide screens and replaces it with a labeled picker on narrow screens', () => {
    expect(workbenchCss).toMatch(/\.test-workbench\s*\{[^}]*grid-template-columns:\s*clamp\(/s);
    expect(workbenchCss).toMatch(/\.test-mobile-suite-picker\s*\{\s*display:\s*none/);
    expect(workbenchCss).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.test-desktop-suite-groups, \.test-run-timeline\s*\{\s*display:\s*none/);
    expect(workbenchCss).toMatch(/@media \(max-width:\s*760px\)[\s\S]*\.test-mobile-suite-picker\s*\{\s*display:\s*grid/);
  });
});
