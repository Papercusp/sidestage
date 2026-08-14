import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RehearsalPanel } from './RehearsalPanel';
import type { RehearsalHistoryEntry, RehearsalReport } from './rehearsals';

/**
 * The panel's job is to answer "what was supposed to happen, and what actually
 * happened" for every case. A pass/fail marker on its own sends a host looking
 * for the answer somewhere else, so these tests hold the expectation text and
 * the observed text to the markup, not just the status word.
 */

function report(overrides: Partial<RehearsalReport> = {}): RehearsalReport {
  return {
    runId: 'run-1',
    kind: 'actions',
    title: 'Guarded actions',
    summary: 'Every guard held.',
    totalCases: 2,
    passedCases: 2,
    passed: true,
    latencyMs: 42,
    ranAt: '2026-08-13T20:00:00.000Z',
    cases: [
      {
        caseId: 'discount-over-cap',
        title: 'A discount above the cap is refused',
        expectation: 'A 60% discount should be refused because the cap is 20%.',
        passed: true,
        observed: 'Refused: over the 20% cap.',
        evidence: { requested: '60%', cap: '20%' },
      },
      {
        caseId: 'discount-under-cap',
        title: 'A discount under the cap is allowed',
        expectation: 'A 10% discount should be allowed.',
        passed: true,
        observed: 'Allowed.',
      },
    ],
    ...overrides,
  };
}

function render(props: Partial<Parameters<typeof RehearsalPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <RehearsalPanel
      title="Guarded actions"
      intro="Can the copilot give away the shop?"
      report={null}
      running={false}
      error={null}
      onRun={() => undefined}
      {...props}
    />,
  );
}

describe('RehearsalPanel', () => {
  it('shows the intro and a not-run status before anything has run', () => {
    const html = render();
    expect(html).toContain('Can the copilot give away the shop?');
    expect(html).toContain('Not run');
    expect(html).toContain('Run rehearsal');
    expect(html).not.toContain('checks held');
  });

  it('disables the button and says so while a run is in flight', () => {
    const html = render({ running: true });
    expect(html).toContain('Running…');
    expect(html).toContain('disabled');
  });

  it('renders the expectation AND what was observed for every case', () => {
    const html = render({ report: report() });
    expect(html).toContain('A 60% discount should be refused because the cap is 20%.');
    expect(html).toContain('Refused: over the 20% cap.');
    expect(html).toContain('A 10% discount should be allowed.');
    expect(html).toContain('Allowed.');
  });

  it('renders evidence key/value pairs when a case carries them', () => {
    const html = render({ report: report() });
    expect(html).toContain('requested');
    expect(html).toContain('60%');
    expect(html).toContain('rehearsal-case-evidence');
  });

  it('marks a failed case as failed and styles it apart from a passing one', () => {
    const failing = report({
      passed: false,
      passedCases: 1,
      cases: [
        {
          caseId: 'discount-over-cap',
          title: 'A discount above the cap is refused',
          expectation: 'A 60% discount should be refused because the cap is 20%.',
          passed: false,
          observed: 'ALLOWED — the cap was not applied.',
        },
        report().cases[1]!,
      ],
    });
    const html = render({ report: failing });

    expect(html).toContain('rehearsal-case is-failed');
    expect(html).toContain('rehearsal-case is-passed');
    expect(html).toContain('ALLOWED — the cap was not applied.');
    expect(html).toContain('Failed');
    expect(html).toContain('Needs attention');
    expect(html).toContain('status-warning');
  });

  it('reports the pass count and the run time in the summary', () => {
    const html = render({ report: report({ passedCases: 1, totalCases: 2, passed: false }) });
    // The count is interpolated as adjacent text nodes, so match across any
    // separator the renderer inserts rather than assuming a bare "1/2".
    expect(html).toMatch(/1(<!--\s*-->)?\/(<!--\s*-->)?2/);
    expect(html).toContain('42ms');
    expect(html).toContain('checks held');
  });

  it('renders caveats when the run could not prove everything', () => {
    const html = render({ report: report({ caveats: ['Payments ran against the sandbox key.'] }) });
    expect(html).toContain('rehearsal-caveats');
    expect(html).toContain('Payments ran against the sandbox key.');
  });

  it('omits the caveat list entirely when there are none', () => {
    expect(render({ report: report() })).not.toContain('rehearsal-caveats');
  });

  it('shows an error without pretending a report exists', () => {
    const html = render({ error: 'The API is unreachable.' });
    expect(html).toContain('The API is unreachable.');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('checks held');
  });

  it('shows previous runs once there is more than one', () => {
    const history: RehearsalHistoryEntry[] = [
      { kind: 'actions', ranAt: '2026-08-13T21:00:00.000Z', passedCases: 2, totalCases: 2, passed: true },
      { kind: 'actions', ranAt: '2026-08-13T20:00:00.000Z', passedCases: 1, totalCases: 2, passed: false },
    ];
    const html = render({ report: report(), history });
    expect(html).toContain('rehearsal-history');
    expect(html).toContain('Previous runs (1)');
  });

  it('hides the history block on a first run — one entry is not a comparison', () => {
    const history: RehearsalHistoryEntry[] = [
      { kind: 'actions', ranAt: '2026-08-13T21:00:00.000Z', passedCases: 2, totalCases: 2, passed: true },
    ];
    expect(render({ report: report(), history })).not.toContain('rehearsal-history');
  });

  it('describes an improvement since the last run', () => {
    const html = render({ report: report(), delta: 1 });
    expect(html).toContain('since the last run');
    expect(html).toContain('+1');
  });

  it('says "No change" rather than "+0" when nothing moved', () => {
    const html = render({ report: report(), delta: 0 });
    expect(html).toContain('No change');
    expect(html).toContain('since the last run');
    expect(html).not.toContain('+0');
  });

  it('keeps the delta value out of its caption, so the number slot is never a word fragment', () => {
    // Regression guard: the tile renders <strong>{value}</strong><span>{caption}</span>.
    // Splitting a sentence to fill those put the bare word "no" in the number slot.
    expect(render({ report: report(), delta: 0 })).toContain('<strong>No change</strong><span>since the last run</span>');
    expect(render({ report: report(), delta: 2 })).toContain('<strong>+2</strong><span>since the last run</span>');
    expect(render({ report: report(), delta: -3 })).toContain('<strong>-3</strong><span>since the last run</span>');
  });

  it('shows no delta at all when there is nothing to compare against', () => {
    const html = render({ report: report(), delta: null });
    expect(html).not.toContain('since the last run');
  });

  it('uses a caller-supplied run label', () => {
    expect(render({ runLabel: 'Rehearse the auction' })).toContain('Rehearse the auction');
  });
});
