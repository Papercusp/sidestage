import { FormEvent, useMemo, useState } from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import type { Stripe } from '@stripe/stripe-js';
// The default @stripe/stripe-js entry injects Stripe.js as soon as this module
// is evaluated. The pure entry keeps the third-party script off every landing
// page and loads it only when the payment step actually requests a client.
import { loadStripe } from '@stripe/stripe-js/pure';
import type { BuyerPaymentSession } from './buyer-checkout-api';

const stripeClients = new Map<string, Promise<Stripe | null>>();

function stripeClient(publishableKey: string): Promise<Stripe | null> {
  const existing = stripeClients.get(publishableKey);
  if (existing) return existing;
  const created = loadStripe(publishableKey);
  stripeClients.set(publishableKey, created);
  return created;
}

export function stripeCheckoutReturnUrl(orderId: string, href?: string): string {
  const base = href ?? (typeof window === 'undefined' ? 'http://localhost/' : window.location.href);
  const url = new URL(base);
  url.searchParams.set('checkout_order', orderId);
  url.searchParams.set('checkout_return', '1');
  return url.toString();
}

export function StripePaymentElementForm({
  orderId,
  amountLabel,
  busy,
  onSubmitted,
  onError,
}: {
  orderId: string;
  amountLabel: string;
  busy: boolean;
  onSubmitted: () => void;
  onError: (message: string) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!stripe || !elements || busy || submitting) return;
    setSubmitting(true);
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: stripeCheckoutReturnUrl(orderId) },
      redirect: 'if_required',
    });
    setSubmitting(false);
    if (result.error) {
      onError(result.error.message ?? 'Stripe could not submit this payment.');
      return;
    }
    // Stripe confirmation is never purchase authority. The verified webhook
    // changes SideStage's order; the drawer only starts polling that record.
    onSubmitted();
  };

  return (
    <form className="buyer-checkout-payment" onSubmit={(event) => void submit(event)}>
      <div className="buyer-stripe-element">
        <PaymentElement options={{ layout: 'tabs' }} />
      </div>
      <button className="button primary" type="submit" disabled={!stripe || !elements || busy || submitting}>
        {busy || submitting ? 'Submitting payment…' : `Pay ${amountLabel}`}
      </button>
      <p>Payment details are collected securely by Stripe and never reach SideStage.</p>
    </form>
  );
}

export function StripePaymentForm({
  session,
  busy,
  onSubmitted,
  onError,
}: {
  session: BuyerPaymentSession;
  busy: boolean;
  onSubmitted: () => void;
  onError: (message: string) => void;
}) {
  const client = useMemo(
    () => session.publishableKey ? stripeClient(session.publishableKey) : null,
    [session.publishableKey],
  );
  if (session.status !== 'ready' || !session.clientSecret || !client) return null;
  return (
    <Elements stripe={client} options={{ clientSecret: session.clientSecret, appearance: { theme: 'stripe' } }}>
      <StripePaymentElementForm
        orderId={session.orderId}
        amountLabel={new Intl.NumberFormat('en-US', { style: 'currency', currency: session.currency })
          .format(session.amountCents / 100)}
        busy={busy}
        onSubmitted={onSubmitted}
        onError={onError}
      />
    </Elements>
  );
}
