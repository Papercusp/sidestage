import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownControl } from './MarkdownControl';
import type { MarkdownPolicyView } from './markdown-guard';

const POLICY: MarkdownPolicyView = {
  maxMarkdownPercent: 30,
  priceFloorCentsByProduct: { 'medication-bag': 200_000 },
};

/** The owner's screenshot: a $5843.93 item in the Studio NOW card. */
const PRICE_CENTS = 584_393;

function render(percent: string) {
  return renderToStaticMarkup(
    <MarkdownControl
      productId="medication-bag"
      title="Medication Bag Heavy Canvas"
      currentPriceCents={PRICE_CENTS}
      policy={POLICY}
      percent={percent}
      onPercentChange={() => {}}
      onApply={() => {}}
    />,
  );
}

/**
 * WI-39838 — at 0% the preview read "$5843.93 → $5843.93", the first struck
 * through: a no-op rendered as a price move, on the seller's own price, mid
 * show. A was→now line is a claim that the price MOVED, so it may only appear
 * when it did.
 */
describe('MarkdownControl price preview', () => {
  it('draws no strike-through and no arrow when the markdown is 0%', () => {
    const html = render('0');
    expect(html).toContain('$5843.93');
    expect(html).not.toContain('markdown-control-was');
    expect(html).not.toContain('→');
  });

  it('draws no strike-through and no arrow when the percent box is empty', () => {
    const html = render('');
    expect(html).toContain('$5843.93');
    expect(html).not.toContain('markdown-control-was');
    expect(html).not.toContain('→');
  });

  it('still shows was → now once the markdown actually moves the price', () => {
    const html = render('10');
    expect(html).toContain('markdown-control-was');
    expect(html).toContain('→');
    // The struck price is the OLD one and the strong price is the NEW one.
    expect(html).toContain('>$5843.93<');
    expect(html).toContain('>$5259.54<');
  });

  it('keeps the preview region mounted at 0% so aria-describedby still resolves', () => {
    const html = render('0');
    // The input names the preview node; an unmounted preview would strand it.
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain('aria-live="polite"');
  });
});
