import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CopilotProposalCard,
  ProductResearchLatency,
  citedSources,
  type CopilotProposal,
} from './CopilotPanel';

function proposal(overrides: Partial<CopilotProposal> = {}): CopilotProposal {
  return {
    id: 'proposal-1',
    eventId: 'event-1',
    question: {
      buyerId: 'buyer-1',
      buyerName: 'Ada',
      text: 'Is the Aurora mug dishwasher safe?',
      createdAt: '2026-08-14T12:00:00.000Z',
    },
    reply: 'Yes. The verified catalog record says it is dishwasher safe.',
    citations: ['catalog:mug-1'],
    context: {
      sources: [
        { id: 'catalog:mug-1', kind: 'catalog-product', label: 'Aurora mug catalog' },
        { id: 'transcript:42', kind: 'transcript', label: 'Live transcript' },
      ],
    },
    status: 'pending',
    createdAt: '2026-08-14T12:00:01.000Z',
    ...overrides,
  };
}

const handlers = {
  onDraftChange: () => undefined,
  onApprove: () => undefined,
  onSkip: () => undefined,
  onConfirmAction: () => undefined,
};

describe('seller copilot proposal review', () => {
  it('shows only sources cited by the grounded proposal', () => {
    const current = proposal();

    expect(citedSources(current).map((source) => source.id)).toEqual(['catalog:mug-1']);
  });

  it('renders an editable grounded reply with approve and skip controls', () => {
    const current = proposal();
    const markup = renderToStaticMarkup(
      <CopilotProposalCard proposal={current} draft={current.reply} {...handlers} />,
    );

    expect(markup).toContain('data-copilot-proposal="proposal-1"');
    expect(markup).toContain('Reply to Ada');
    expect(markup).toContain('Aurora mug catalog');
    expect(markup).not.toContain('Live transcript');
    expect(markup).toContain('Approve reply');
    expect(markup).toContain('Skip');
  });

  it('shows measured product-research latency against the sub-2s budget', () => {
    const withinBudget = renderToStaticMarkup(<ProductResearchLatency latencyMs={184} />);
    const overBudget = renderToStaticMarkup(<ProductResearchLatency latencyMs={2_050} />);
    const legacy = renderToStaticMarkup(<ProductResearchLatency />);

    expect(withinBudget).toContain('184ms · within the sub-2s budget');
    expect(withinBudget).toContain('status-success');
    expect(overBudget).toContain('2050ms · over the sub-2s budget');
    expect(overBudget).toContain('status-warning');
    expect(legacy).toBe('');
  });

  it('surfaces a blocked grounding result without review controls', () => {
    const current = proposal({
      status: 'blocked',
      citations: [],
      error: 'The catalog fact changed after this draft was prepared.',
    });
    const markup = renderToStaticMarkup(
      <CopilotProposalCard proposal={current} draft={current.reply} {...handlers} />,
    );

    expect(markup).toContain('The catalog fact changed after this draft was prepared.');
    expect(markup).toContain('No verified citation');
    expect(markup).not.toContain('Approve reply');
    expect(markup).not.toContain('Confirm action');
  });

  it('announces a skipped transition without adding a second blocked/approved alert', () => {
    const current = proposal({ status: 'skipped' });
    const markup = renderToStaticMarkup(
      <CopilotProposalCard proposal={current} draft={current.reply} {...handlers} />,
    );

    expect(markup).toContain('copilot-review-status" role="status" aria-live="polite" aria-atomic="true">skipped');
    expect(markup).not.toContain('role="alert"');
  });

  it('requires an explicit seller confirmation for a guarded action', () => {
    const current = proposal({
      action: {
        proposal: {
          kind: 'hold-inventory',
          productId: 'mug-1',
          quantity: 1,
          reason: 'Hold the item while the buyer checks out.',
        },
        disposition: 'awaiting-confirmation',
        guardrail: { allowed: true },
      },
    });
    const markup = renderToStaticMarkup(
      <CopilotProposalCard proposal={current} draft={current.reply} {...handlers} />,
    );

    expect(markup).toContain('Guarded action');
    expect(markup).toContain('hold inventory · 1 unit');
    expect(markup).toContain('Confirm action');
  });
});
