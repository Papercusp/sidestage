/**
 * OfferComposer (plan sidestage-lineup-run-of-show-2026-08-16, P-006 / D-007).
 *
 * The component exists because the Lineup timeline's inline offer block guarded
 * only "a buyer is chosen" and "the price parses" — so it enabled Send for
 * below-floor offers the server refuses, which the grid it replaced had blocked.
 * These tests are therefore written to FAIL if that weaker guard comes back:
 * the below-floor case must be UNSENDABLE and must SAY why.
 *
 * Every case pairs a blocked assertion with a sendable one on the same policy.
 * A disabled-button assertion alone passes just as happily against a button that
 * is disabled for some unrelated reason (or permanently), which would make the
 * whole file vacuous.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OfferComposer, emptyOfferDraft, type OfferDraft } from './OfferComposer';
import type { BuyerCandidate } from './offer-guard';
import type { MarkdownPolicyView } from './markdown-guard';

const BUYERS: BuyerCandidate[] = [
  { buyerId: 'buyer-1', displayName: 'Ada', source: 'room' },
  { buyerId: 'buyer-2', displayName: 'Grace', source: 'bidder' },
];

/** A $20 product with a $15 floor, so 14.00 is below and 16.00 is above. */
const POLICY: MarkdownPolicyView = { priceFloorCentsByProduct: { 'p-kettle': 1500 } };

function render(overrides: {
  draft?: Partial<OfferDraft>;
  policy?: MarkdownPolicyView | null;
  blockedActionKinds?: readonly string[];
  candidates?: readonly BuyerCandidate[];
} = {}): string {
  return renderToStaticMarkup(
    <OfferComposer
      productId="p-kettle"
      title="Copper Kettle"
      currentPriceCents={2000}
      availableQty={5}
      policy={overrides.policy === undefined ? POLICY : overrides.policy}
      blockedActionKinds={overrides.blockedActionKinds}
      candidates={overrides.candidates ?? BUYERS}
      draft={{ ...emptyOfferDraft(), ...overrides.draft }}
      onDraftChange={() => undefined}
      onSend={() => undefined}
    />,
  );
}

/** The rendered Send button, with its disabled state — '' when absent. */
function sendButton(markup: string): string {
  return markup.match(/<button[^>]*>Send offer<\/button>/)?.[0] ?? '';
}

describe('OfferComposer', () => {
  it('BLOCKS a below-floor offer and names the floor as the reason', () => {
    const markup = render({ draft: { buyerId: 'buyer-1', price: '14.00' } });

    expect(sendButton(markup)).toContain('disabled');
    /*
     * The reason states the LIMITING PRICE, not just that something is wrong —
     * a disabled button with no actionable number is what sellers report as
     * "the app is broken". Asserting the $15.00 rather than the word "floor"
     * also keeps this test about the seller-facing contract instead of internal
     * vocabulary: the copy deliberately does not say "floor".
     */
    expect(markup).toContain('$15.00');
  });

  it('ALLOWS an at-or-above-floor offer from the same policy — the falsifier', () => {
    const markup = render({ draft: { buyerId: 'buyer-1', price: '16.00' } });

    // Without this case the test above would pass against a permanently
    // disabled button, proving nothing about the guard.
    expect(sendButton(markup)).not.toContain('disabled');
  });

  it('blocks sending before a buyer has been chosen', () => {
    const markup = render({ draft: { buyerId: '', price: '16.00' } });

    expect(sendButton(markup)).toContain('disabled');
  });

  it('says nobody is here rather than offering a picker with no one in it', () => {
    const markup = render({ candidates: [], draft: { price: '16.00' } });

    expect(sendButton(markup)).toContain('disabled');
    expect(markup).toMatch(/no buyers/i);
  });

  it('replaces the whole control with a reason when the event blocks targeted offers', () => {
    const markup = render({
      blockedActionKinds: ['targeted-offer'],
      draft: { buyerId: 'buyer-1', price: '16.00' },
    });

    // Rendering controls whose action the server is guaranteed to refuse is
    // worse than rendering none: it invites the seller to compose a doomed offer.
    expect(markup).toContain('does not allow targeted offers');
    expect(markup).not.toContain('Send offer');
  });

  it('never raises the verified event price', () => {
    const markup = render({ draft: { buyerId: 'buyer-1', price: '25.00' } });

    expect(sendButton(markup)).toContain('disabled');
  });
});
