import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CopilotReplyReview,
  ProductResearchLatency,
  copilotProductToBuyerProduct,
  sellerReplyInput,
} from './CopilotPanel';

describe('seller copilot reply review', () => {
  it('builds an approved reply for the shared EventChat mutation seam', () => {
    expect(sellerReplyInput('  Edited reply  ')).toEqual({
      userId: 'seller-copilot-review',
      displayName: 'Host',
      role: 'seller',
      text: 'Edited reply',
    });
  });

  it('maps a verified scout result into the app-wide buyer checkout model', () => {
    expect(copilotProductToBuyerProduct({
      productId: 'mug-1',
      title: 'Aurora mug',
      description: 'Hand-thrown stoneware',
      priceCents: 2500,
      availableQty: 3,
      imageUrl: '/mug.png',
      attributes: { material: 'stoneware' },
    })).toEqual({
      id: 'mug-1',
      title: 'Aurora mug',
      subtitle: 'Hand-thrown stoneware',
      priceCents: 2500,
      availableQty: 3,
      imageUrl: '/mug.png',
    });
  });

  it('renders the approve, edit, and skip review actions', () => {
    const markup = renderToStaticMarkup(
      <CopilotReplyReview
        draft="The mug is dishwasher safe."
        editing={false}
        status="pending"
        onDraftChange={() => undefined}
        onEdit={() => undefined}
        onApprove={() => undefined}
        onSkip={() => undefined}
      />,
    );
    expect(markup).toContain('data-copilot-reply-review="true"');
    expect(markup).toContain('Approve');
    expect(markup).toContain('Edit');
    expect(markup).toContain('Skip');
  });

  it('shows product-research latency against the sub-2s release budget', () => {
    const withinBudget = renderToStaticMarkup(<ProductResearchLatency latencyMs={184} />);
    const overBudget = renderToStaticMarkup(<ProductResearchLatency latencyMs={2_050} />);

    expect(withinBudget).toContain('184ms · within the sub-2s budget');
    expect(withinBudget).toContain('status-success');
    expect(overBudget).toContain('2050ms · over the sub-2s budget');
    expect(overBudget).toContain('status-warning');
  });
});
