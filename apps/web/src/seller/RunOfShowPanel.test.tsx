import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  buildRunOfShowView,
  emptyStageLog,
  stageLogOnProductChange,
  type RunOfShowEntry,
} from '../run-of-show';
import { RunOfShowPanelView } from './RunOfShowPanel';
import { appendProductToDraft, RunOfShowPlannerView } from './RunOfShowPlannerPanel';

const T0 = 1_000_000_000_000;

const ENTRIES: RunOfShowEntry[] = [
  { productId: 'a', plannedDurationSec: 300, notes: 'Lead with the glaze story.' },
  { productId: 'b', plannedDurationSec: 120, notes: '' },
  { productId: 'c', plannedDurationSec: 180, notes: 'Call out the hand-painted rim.' },
];
const TITLES = { a: 'Aurora Cup', b: 'Beacon Mug', c: 'Comet Bowl' };
const ACTIVE_PRODUCT = {
  id: 'a',
  name: 'Aurora Cup',
  price: '$42.00',
  description: 'Hand-finished stoneware.',
  stockLabel: '3 available',
  tone: 'cyan' as const,
  glyph: '◒',
};

function viewAt(activeProductId: string | null) {
  let log = emptyStageLog();
  if (activeProductId) log = stageLogOnProductChange(log, activeProductId, T0);
  return buildRunOfShowView({ entries: ENTRIES, titles: TITLES, log, nowMs: T0 + 65_000 });
}

describe('RunOfShowPanelView', () => {
  it('surfaces the staged product notes, its clock against budget, and the pace line', () => {
    const html = renderToStaticMarkup(
      <RunOfShowPanelView
        view={viewAt('a')}
        loaded
        error={null}
        onStageNext={() => undefined}
        activeProduct={ACTIVE_PRODUCT}
        pricingHistory={<p>Pricing history fixture</p>}
      />,
    );
    // Notes appear unprompted with the staged product (D-002).
    expect(html).toContain('Lead with the glaze story.');
    // Elapsed vs budget, soft (1:05 of 5:00).
    expect(html).toContain('1:05');
    expect(html).toContain('5:00');
    // Next-up is a suggestion with a one-tap action, not an auto-stage (D-001).
    expect(html).toContain('>Next<');
    expect(html).toContain('Beacon Mug');
    expect(html).toContain('Take live');
    // The former On Deck content now lives inside the one active timeline card.
    expect(html).toContain('$42.00');
    expect(html).toContain('3 available');
    expect(html).toContain('Pricing history fixture');
    // Aggregate pace line present.
    expect(html).toContain('On pace');
    expect(html).toContain('1:05 elapsed');
    // Later products are compact disclosures rather than additional open panes.
    expect(html).toContain('run-of-show-later-card');
    expect(html).toContain('Comet Bowl');
  });

  it('groups completed slots behind a collapsed disclosure', () => {
    let log = stageLogOnProductChange(emptyStageLog(), 'a', T0);
    log = stageLogOnProductChange(log, 'b', T0 + 45_000);
    const view = buildRunOfShowView({ entries: ENTRIES, titles: TITLES, log, nowMs: T0 + 65_000 });
    const html = renderToStaticMarkup(
      <RunOfShowPanelView view={view} loaded error={null} onStageNext={() => undefined} />,
    );

    expect(html).toContain('<summary>1 completed</summary>');
    expect(html).toContain('Aurora Cup');
    expect(html).toContain('aria-current="step"');
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
  it('adds a product at most once across rapid batched clicks', () => {
    const once = appendProductToDraft([], 'c');
    const twice = appendProductToDraft(once, 'c');
    const threeTimes = appendProductToDraft(twice, 'c');

    expect(threeTimes).toBe(once);
    expect(threeTimes).toEqual([{ productId: 'c', minutes: '', notes: '' }]);
  });

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
