import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventReadinessView } from './EventReadinessPanel';
import type { PreflightReport } from './rehearsals';

const REPORT: PreflightReport = {
  eventId: 'sunday-drop',
  ranAt: '2026-08-14T14:00:00.000Z',
  ready: false,
  blockers: 1,
  warnings: 0,
  unknowns: 0,
  checks: [
    {
      id: 'event-name',
      label: 'Event identity',
      status: 'ready',
      detail: 'Sunday drop is configured.',
    },
    {
      id: 'reserved-lineup',
      label: 'Reserved lineup',
      status: 'blocker',
      detail: 'No inventory is reserved.',
      remedy: 'Reserve at least one catalog item.',
    },
  ],
};

describe('EventReadinessView', () => {
  it('makes the event scope and corrective evidence explicit', () => {
    const markup = renderToStaticMarkup(
      <EventReadinessView
        eventId="sunday-drop"
        report={REPORT}
        loading={false}
        error={null}
        onRun={() => undefined}
      />,
    );

    expect(markup).toContain('Current event · preflight');
    expect(markup).toContain('sunday-drop');
    expect(markup).toContain('1 blocker to fix');
    expect(markup).toContain('Reserved lineup');
    expect(markup).toContain('Next: Reserve at least one catalog item.');
    expect(markup).toContain('Run event preflight');
  });

  it('does not claim readiness while the event report is still loading', () => {
    const markup = renderToStaticMarkup(
      <EventReadinessView
        eventId="new-event"
        report={null}
        loading
        error={null}
        onRun={() => undefined}
      />,
    );

    expect(markup).toContain('Checking this event…');
    expect(markup).toContain('Running event preflight…');
    expect(markup).not.toContain('Ready for this event');
  });
});
