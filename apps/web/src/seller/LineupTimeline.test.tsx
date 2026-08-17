/**
 * LineupTimelineView (plan sidestage-lineup-run-of-show-2026-08-16, P-004).
 *
 * These tests are written to FAIL if the decisions the component exists to obey
 * are broken, not merely to re-describe the markup:
 *
 *  - D-003: with no shared clock, NO time is rendered at all — not a zero.
 *  - D-005: the "on stage" chip tracks the SERVER's `item.onStage`, not the slot
 *    state the local clock derives, because those two have historically drifted.
 *  - D-002: every number shown comes from `buildRunOfShowView` — so the view is
 *    built by the real module here rather than hand-stubbed, and a regression in
 *    the pacing rule surfaces as a changed assertion instead of passing quietly.
 *  - The advisory contract: an off-plan product on stage is reported, never
 *    treated as an error, and nothing is disabled because the plan disagrees.
 *  - The drawer is not mounted while closed (the documented perf anti-pattern).
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  buildRunOfShowView,
  emptyStageLog,
  stageLogOnProductChange,
  type RunOfShowEntry,
  type StageLog,
} from '../run-of-show';
import type { SellerEventItem } from '../events/api';
import { emptySlotDraft, LineupTimelineView, type TimelineDrafts } from './LineupTimeline';

const T0 = 1_700_000_000_000;

const ENTRIES: RunOfShowEntry[] = [
  { productId: 'p-kettle', plannedDurationSec: 300, notes: 'Open with the kettle' },
  { productId: 'p-mug', plannedDurationSec: 120, notes: '' },
];

const TITLES: Record<string, string> = {
  'p-kettle': 'Copper Kettle',
  'p-mug': 'Enamel Mug',
  'p-tray': 'Serving Tray',
};

function item(productId: string, overrides: Partial<SellerEventItem> = {}): SellerEventItem {
  return {
    eventId: 'ev-1',
    eventItemId: `ei-${productId}`,
    productId,
    title: TITLES[productId] ?? productId,
    priceCents: 4_000,
    availableQty: 9,
    quantity: 4,
    attributes: {},
    ...overrides,
  };
}

function drafts(): TimelineDrafts {
  return {
    'p-kettle': { ...emptySlotDraft(), minutes: '5', notes: 'Open with the kettle' },
    'p-mug': { ...emptySlotDraft(), minutes: '2' },
  };
}

/** The kettle has been on stage for 6 minutes against a 5-minute budget. */
function liveLog(): StageLog {
  return stageLogOnProductChange(emptyStageLog(), 'p-kettle', T0);
}

function render(props: Partial<Parameters<typeof LineupTimelineView>[0]> = {}): string {
  const log = props.view ? emptyStageLog() : liveLog();
  const view =
    props.view ??
    buildRunOfShowView({
      entries: ENTRIES,
      titles: TITLES,
      log,
      nowMs: T0 + 360_000,
      lineupProductIds: ['p-kettle', 'p-mug', 'p-tray'],
    });

  return renderToStaticMarkup(
    <LineupTimelineView
      view={view}
      drafts={drafts()}
      showPace
      saveStatus="idle"
      items={[item('p-kettle', { onStage: true }), item('p-mug'), item('p-tray')]}
      openProductId={null}
      onDraftChange={() => {}}
      onMove={() => {}}
      onReorder={() => {}}
      onRemoveFromShow={() => {}}
      onAddToShow={() => {}}
      onSave={() => {}}
      onToggleDrawer={() => {}}
      onPush={() => {}}
      onSwap={() => {}}
      onMarkdown={() => {}}
      onStockAdjust={() => {}}
      onStartAuction={() => {}}
      onSendOffer={() => {}}
      {...props}
    />,
  );
}

describe('LineupTimelineView', () => {
  it('renders planned slots in plan order with their positions', () => {
    const html = render();
    expect(html).toContain('Copper Kettle');
    expect(html).toContain('Enamel Mug');
    expect(html.indexOf('Copper Kettle')).toBeLessThan(html.indexOf('Enamel Mug'));
    expect(html).toContain('lineup-slot-p-kettle');
  });

  it('shows elapsed and pace from run-of-show.ts when a clock is present', () => {
    const html = render({ showPace: true });
    // 6:00 on stage against a 5:00 budget -> 1m behind plan, 1 slot still to go.
    expect(html).toContain('6:00');
    expect(html).toContain('1m behind plan');
    expect(html).toContain('1 to go');
    expect(html).toContain('1:00 over');
  });

  it('D-003: with no shared clock it renders NO time at all, not a zero', () => {
    const html = render({ showPace: false });
    expect(html).toContain('Show clock unavailable');
    // The falsifier: a component that fell back to a local clock, or that
    // rendered the log's zero, would print a clock string here.
    expect(html).not.toContain('0:00');
    expect(html).not.toContain('6:00');
    expect(html).not.toContain('on pace');
    expect(html).not.toContain('behind plan');
    expect(html).not.toContain('on stage</span>');
  });

  it("D-005: the on-stage chip follows the server's onStage flag, not the slot state", () => {
    // The clock says p-kettle is active, but the SERVER says p-mug is staged.
    // The chip must follow the server, or the chip and the Push button below it
    // would tell the seller different stories.
    const html = render({ items: [item('p-kettle'), item('p-mug', { onStage: true }), item('p-tray')] });
    const kettleRow = html.slice(html.indexOf('lineup-slot-p-kettle'), html.indexOf('lineup-slot-p-mug'));
    const mugRow = html.slice(html.indexOf('lineup-slot-p-mug'));
    expect(mugRow).toContain('On stage');
    expect(kettleRow).not.toContain('On stage');
  });

  it('D-005, the other direction: the chip MOVES with the server flag', () => {
    // Together with the test above this is what makes the pair falsifiable, with
    // no mutation of the component needed. The stage LOG is identical in both
    // cases (p-kettle is the active slot either way), so any implementation that
    // keyed the chip off `slot.state` would put it on the kettle BOTH times and
    // could not produce these two opposite results. Only reading the server flag
    // does.
    const html = render({ items: [item('p-kettle', { onStage: true }), item('p-mug'), item('p-tray')] });
    const kettleRow = html.slice(html.indexOf('lineup-slot-p-kettle'), html.indexOf('lineup-slot-p-mug'));
    const mugRow = html.slice(html.indexOf('lineup-slot-p-mug'));
    expect(kettleRow).toContain('On stage');
    expect(mugRow).not.toContain('On stage');
  });

  it('reports an off-plan product as a detour rather than an error', () => {
    const view = buildRunOfShowView({
      entries: ENTRIES,
      titles: TITLES,
      log: stageLogOnProductChange(emptyStageLog(), 'p-tray', T0),
      nowMs: T0 + 30_000,
      lineupProductIds: ['p-kettle', 'p-mug', 'p-tray'],
    });
    const html = render({ view });
    expect(html).toContain('Serving Tray');
    expect(html).toContain('is not in the plan');
    expect(html).toContain('the plan is a guide, not a rail');
    // Advisory, not a failure: the detour must not be styled as an error.
    expect(html).not.toContain('lineup-timeline-error');
  });

  it('lists lineup products the plan omits in the reserved tray', () => {
    const html = render();
    const tray = html.slice(html.indexOf('lineup-timeline-tray'));
    expect(tray).toContain('Serving Tray');
    expect(tray).toContain('Add to show');
    // Planned products belong in the timeline, never in the tray.
    expect(tray).not.toContain('Copper Kettle');
  });

  it('does not mount a slot drawer while it is closed', () => {
    const closed = render({ openProductId: null });
    expect(closed).not.toContain('markdown-control');
    expect(closed).not.toContain('Start auction');

    const open = render({ openProductId: 'p-kettle' });
    expect(open).toContain('markdown-control');
    expect(open).toContain('Start auction');
    expect(open).toContain('Live quantity');
  });

  it('replaces the offer control with a reason when the event blocks targeted offers', () => {
    const open = render({ openProductId: 'p-kettle', blockedActionKinds: ['targeted-offer'] });
    expect(open).toContain('does not allow targeted offers');
    expect(open).not.toContain('Send offer');
    // Blocking offers must not take the rest of the drawer down with it.
    expect(open).toContain('markdown-control');
  });

  it('flags an out-of-range minutes budget without blocking anything', () => {
    const html = render({
      drafts: { 'p-kettle': { ...emptySlotDraft(), minutes: '999' }, 'p-mug': emptySlotDraft() },
    });
    expect(html).toContain('aria-invalid="true"');
    // An empty budget is legal, so it must not be flagged.
    const mugRow = html.slice(html.indexOf('lineup-slot-p-mug'));
    expect(mugRow).not.toContain('aria-invalid="true"');
  });

  it('offers a keyboard reorder affordance, not drag alone', () => {
    const html = render();
    expect(html).toContain('arrow up and arrow down');
  });
});
