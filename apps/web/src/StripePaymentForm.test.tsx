import { createElement, type PropsWithChildren } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@stripe/stripe-js/pure', () => ({ loadStripe: vi.fn(() => Promise.resolve({})) }));
vi.mock('@stripe/react-stripe-js', () => ({
  Elements: ({ children }: PropsWithChildren) => createElement('div', { 'data-stripe-elements': true }, children),
  PaymentElement: () => createElement('div', null, 'Secure payment fields'),
  useStripe: () => ({}),
  useElements: () => ({}),
}));

import { StripePaymentForm, stripeCheckoutReturnUrl } from './StripePaymentForm';

describe('StripePaymentForm', () => {
  it('renders Stripe Payment Element without exposing provider credentials', () => {
    const html = renderToStaticMarkup(<StripePaymentForm
      session={{
        provider: 'stripe', mode: 'test', status: 'ready', publishableKey: 'pk_test_public',
        clientSecret: 'pi_1_secret_private', paymentIntentId: 'pi_1', orderId: 'order-1',
        amountCents: 3599, currency: 'USD',
      }}
      busy={false}
      onSubmitted={vi.fn()}
      onError={vi.fn()}
    />);
    expect(html).toContain('Secure payment fields');
    expect(html).toContain('Pay $35.99');
    expect(html).toContain('collected securely by Stripe');
    expect(html).not.toContain('pi_1_secret_private');
  });

  it('builds a stable return URL that preserves the current SideStage location', () => {
    expect(stripeCheckoutReturnUrl('order 1', 'https://sidestage.test/?tab=orders#history'))
      .toBe('https://sidestage.test/?tab=orders&checkout_order=order+1&checkout_return=1#history');
  });
});
