import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  buildRunOfShowView,
  emptyStageLog,
  stageLogOnProductChange,
  type RunOfShowEntry,
} from '../run-of-show';
import { RunOfShowPanelView } from './RunOfShowPanel';
import { RunOfShowPlannerView } from './RunOfShowPlannerPanel';

const T0 = 1_000_000_000_000;

const ENTRIES: RunOfShowEntry[] = [
  { productId: 'a', plannedDurationSec: 300, notes: 'Lead with the glaze story.' },
  { productId: 'b', plannedDurationSec: 120, notes: '' },
];
const TITLES = { a: 'Aurora Cup', b: 'Beacon Mug' };

function viewAt(activeProductId: string | null) {
  let log = emptyStageLog();
  if (activeProductId) log = stageLogOnProductChange(log, activeProductId, T0);
  return buildRunOfShowView({ entries: ENTRIES, titles: TITLES, log, nowMs: T0 + 65_000 });
}

describe('RunOfShowPanelView', () => {
  it('surfaces the staged product notes, its clock against budget, and the pace line', () => {
    const html = renderToStaticMarkup(
      <RunOfShowPanelView view={viewAt('a')} loaded error={null} onStageNext={() => undefined} />,
    );
    // Notes appear unprompted with the staged product (D-002).
    expect(html).toContain('Lead with the glaze story.');
    // Elapsed vs budget, soft (1:05 of 5:00).
    expect(html).toContain('1:05');
    expect(html).toContain('5:00');
    // Next-up is a suggestion with a one-tap action, not an auto-stage (D-001).
    expect(html).toContain('Next up');
    expect(html).toContain('Beacon Mug');
    expect(html).toContain('Put on deck');
    // Aggregate pace line reports the actual delta and remaining lineup.
    expect(html).toContain('4m ahead of plan');
    expect(html).toContain('1 to go');
  });

  it('renders the planless empty state with a pointer to the planner', () => {
    const empty = buildRunOfShowView({ entries: [], titles: {}, log: emptyStageLog(), nowMs: T0 });
    const html = renderToStaticMarkup(
      <RunOfShowPanelView view={empty} loaded error={null} onStageNext={() => undefined} />,
    );
    expect(html).toContain('No show plan yet');
    expect(html).toContain('Event Manager');
  });
});

describe('RunOfShowPlannerView', () => {
  it('renders ordered rows with minutes + notes fields and the unplanned list', () => {
    const html = renderToStaticMarkup(
      <RunOfShowPlannerView
        rows={[
          { productId: 'a', minutes: '5', notes: 'Lead with the glaze story.' },
          { productId: 'b', minutes: '', notes: '' },
        ]}
        titles={TITLES}
        unplanned={[{ productId: 'c', title: 'Comet Bowl' }]}
        status="idle"
        error={null}
        onMove={() => undefined}
        onRemove={() => undefined}
        onAdd={() => undefined}
        onMinutes={() => undefined}
        onNotes={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(html).toContain('Aurora Cup');
    expect(html).toContain('Lead with the glaze story.');
    // The plan is explicitly a guide, never a lock (D-001).
    expect(html).toContain('never locks you to it');
    // Unplanned lineup products are offered, not auto-added.
    expect(html).toContain('Comet Bowl');
    expect(html).toContain('Add to plan');
    expect(html).toContain('Save show plan');
  });
});
