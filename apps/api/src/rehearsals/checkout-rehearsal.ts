import { CartService, InMemoryCartStore } from '../cart/cart.service';
import {
  CheckoutService,
  InMemoryOrderStore,
  type CheckoutOrder,
  type PaymentProvider,
  type PaymentSession,
  type StripePaymentEvent,
} from '../checkout/checkout.service';
import { CheckoutSourceService } from '../checkout/checkout-source.service';
import { MAX_WEIGHT_OZ, packItems } from '../shipping/box-packer';
import { ShippingService, type AggregatedRate } from '../shipping/shipping.service';
import {
  buildRehearsalReport,
  centsToDollars,
  expectRefusal,
  runCase,
} from './rehearsal.report';
import type { RehearsalCaseResult, RehearsalReport } from './rehearsal.types';

/**
 * The checkout rehearsal.
 *
 * Checkout is where a rounding error stops being cosmetic. These cases drive
 * the real CartService, CheckoutService and box packer, and check the things
 * that cost real money when they are wrong: that the amount handed to the
 * payment provider is the amount the order says, that pressing pay twice does
 * not charge twice, and that a failed payment never reads as a sale.
 *
 * The payment PROVIDER is the one seam that is deliberately stood in for — a
 * launch rehearsal must never post to a real payment API. That substitution is
 * reported as a caveat on the report so a green run is never mistaken for
 * proof that Stripe itself is healthy.
 */

const PAYMENT_CAVEAT = 'Payments used a local stand-in provider, not Stripe — this proves SideStage\'s own totals, webhook transitions, and idempotency, not that Stripe is reachable.';

/** Records exactly what checkout asked the provider to charge. */
class RecordingPaymentProvider implements PaymentProvider {
  readonly sessionCharges: number[] = [];
  readonly webhookCharges: number[] = [];
  private nextEvent: StripePaymentEvent | null = null;

  async createSession(input: Parameters<PaymentProvider['createSession']>[0]): Promise<PaymentSession> {
    this.sessionCharges.push(input.amountCents);
    return {
      provider: 'stripe',
      mode: 'test',
      status: 'ready',
      publishableKey: 'pk_test_rehearsal',
      clientSecret: `pi_${input.orderId}_secret_rehearsal`,
      paymentIntentId: input.paymentIntentId ?? `pi_${input.orderId}`,
      orderId: input.orderId,
      amountCents: input.amountCents,
      currency: input.currency,
    };
  }

  async parseWebhook(): Promise<StripePaymentEvent | null> {
    return this.nextEvent;
  }

  async deliver(
    checkout: CheckoutService,
    order: CheckoutOrder,
    type: StripePaymentEvent['type'],
    id = `evt_rehearsal_${this.webhookCharges.length + 1}`,
  ) {
    this.webhookCharges.push(order.totalCents);
    this.nextEvent = {
      id,
      created: 1_786_751_000 + this.webhookCharges.length,
      type,
      mode: 'test',
      paymentIntentId: order.stripePaymentIntentId!,
      orderId: order.id,
      buyerId: order.buyerId,
      sourceKind: order.sourceKind,
      sourceId: order.sourceId,
      amountCents: order.totalCents,
      amountReceivedCents: type === 'succeeded' ? order.totalCents : undefined,
      currency: order.currency,
      errorMessage: type === 'failed' ? 'Rehearsal declined this payment on purpose.' : undefined,
    };
    return checkout.handleWebhook(Buffer.from('{}'), 'rehearsal-signature');
  }
}

interface ScriptedCheckout {
  carts: CartService;
  checkout: CheckoutService;
  provider: RecordingPaymentProvider;
}

function scripted(): ScriptedCheckout {
  const carts = new CartService(new InMemoryCartStore());
  const provider = new RecordingPaymentProvider();
  const shipping = {
    resolveRateForItems: async (_input: unknown, rateId: string) => {
      if (rateId !== REHEARSAL_RATE.id) throw new Error('Shipping rate is unavailable or expired');
      return { ...REHEARSAL_RATE };
    },
  } as unknown as ShippingService;
  const sources = new CheckoutSourceService(carts, undefined as never, undefined as never);
  return { carts, provider, checkout: new CheckoutService(provider, new InMemoryOrderStore(), sources, shipping) };
}

const CUP_CENTS = 2_800;
const PLATE_CENTS = 1_950;
const SHIPPING_CENTS = 795;
const REHEARSAL_ORDER_CONTEXT = { buyerId: 'rehearsal-buyer', eventId: 'rehearsal-event' } as const;
const REHEARSAL_RATE: AggregatedRate = {
  id: 'rehearsal:ground', carrier: 'Rehearsal', service: 'Ground', totalCents: SHIPPING_CENTS,
  deliveryDays: 3, parcelCount: 1, quotedAt: '2026-08-14T00:00:00.000Z',
};
const REHEARSAL_SHIPPING_CONTEXT = {
  shippingAddress: { name: 'Rehearsal Buyer', line1: '99 Main St', city: 'New York', state: 'NY', postalCode: '10001', country: 'US' },
  shippingRateId: REHEARSAL_RATE.id,
} as const;

/** Two cups + one plate. */
async function scriptedCart(carts: CartService): Promise<string> {
  const created = await carts.addItem({ productId: 'aurora-cup', title: 'Aurora ceramic cup', priceCents: CUP_CENTS, quantity: 2 });
  await carts.addItem({ cartId: created.id, productId: 'aurora-plate', title: 'Aurora side plate', priceCents: PLATE_CENTS, quantity: 1 });
  return created.id;
}

const EXPECTED_SUBTOTAL = CUP_CENTS * 2 + PLATE_CENTS;

export async function runCheckoutRehearsal(options: { now?: () => number } = {}): Promise<RehearsalReport> {
  const now = options.now ?? Date.now;
  const startedMs = now();
  const cases: RehearsalCaseResult[] = [];

  cases.push(await runCase(
    {
      caseId: 'totals-add-up',
      title: 'The total is the items plus shipping — exactly',
      expectation: `Two cups and a plate is ${centsToDollars(EXPECTED_SUBTOTAL)}; with ${centsToDollars(SHIPPING_CENTS)} shipping the order total must be ${centsToDollars(EXPECTED_SUBTOTAL + SHIPPING_CENTS)}, with nothing lost or invented.`,
    },
    async () => {
      const context = scripted();
      const cartId = await scriptedCart(context.carts);
      const { order } = await context.checkout.createSession({ cartId, ...REHEARSAL_ORDER_CONTEXT, ...REHEARSAL_SHIPPING_CONTEXT });
      const identityHolds = order.subtotalCents === EXPECTED_SUBTOTAL
        && order.totalCents === order.subtotalCents + order.shippingCents;
      return {
        passed: identityHolds,
        observed: `${centsToDollars(order.subtotalCents)} items + ${centsToDollars(order.shippingCents)} shipping = ${centsToDollars(order.totalCents)}.`,
        evidence: {
          subtotal: centsToDollars(order.subtotalCents),
          shipping: centsToDollars(order.shippingCents),
          total: centsToDollars(order.totalCents),
        },
      };
    },
  ));

  cases.push(await runCase(
    {
      caseId: 'charge-matches-the-order',
      title: 'The buyer is charged what the order says',
      expectation: 'The amount handed to the payment provider must equal the order total — a shipping line shown but not charged is money lost on every sale.',
    },
    async () => {
      const context = scripted();
      const cartId = await scriptedCart(context.carts);
      const { order } = await context.checkout.createSession({ cartId, ...REHEARSAL_ORDER_CONTEXT, ...REHEARSAL_SHIPPING_CONTEXT });
      const charged = context.provider.sessionCharges[0];
      const matches = charged === order.totalCents;
      return {
        passed: matches,
        observed: matches
          ? `Charged ${centsToDollars(charged ?? 0)}, matching the order total.`
          : `Order says ${centsToDollars(order.totalCents)} but the provider was asked for ${centsToDollars(charged ?? 0)}.`,
        evidence: { orderTotal: centsToDollars(order.totalCents), charged: centsToDollars(charged ?? 0) },
      };
    },
  ));

  cases.push(await runCase(
    {
      caseId: 'no-duplicate-order',
      title: 'Reopening checkout does not create a second order',
      expectation: 'A buyer who returns to checkout must land on the SAME pending order, not a duplicate that could be paid separately.',
    },
    async () => {
      const context = scripted();
      const cartId = await scriptedCart(context.carts);
      const first = await context.checkout.createSession({ cartId, ...REHEARSAL_ORDER_CONTEXT, ...REHEARSAL_SHIPPING_CONTEXT });
      const second = await context.checkout.createSession({ cartId, ...REHEARSAL_ORDER_CONTEXT, ...REHEARSAL_SHIPPING_CONTEXT });
      const same = first.order.id === second.order.id;
      return {
        passed: same,
        observed: same ? 'Both visits resolved to the same pending order.' : 'A second order was created for the same cart.',
        evidence: { firstOrder: first.order.id, secondOrder: second.order.id, sessionsOpened: context.provider.sessionCharges.length },
      };
    },
  ));

  cases.push(await runCase(
    {
      caseId: 'no-double-charge',
      title: 'A duplicate success webhook does not commit twice',
      expectation: 'Redelivering an already-applied Stripe success must return the existing sale without repeating SideStage payment side effects.',
    },
    async () => {
      const context = scripted();
      const cartId = await scriptedCart(context.carts);
      const { order } = await context.checkout.createSession({ cartId, ...REHEARSAL_ORDER_CONTEXT, ...REHEARSAL_SHIPPING_CONTEXT });
      await context.provider.deliver(context.checkout, order, 'succeeded', 'evt_rehearsal_success');
      const repeat = await context.provider.deliver(context.checkout, order, 'succeeded', 'evt_rehearsal_success');
      const chargedOnce = context.provider.sessionCharges.length === 1;
      return {
        passed: chargedOnce && repeat.order?.status === 'paid' && repeat.handled === false,
        observed: chargedOnce
          ? 'The duplicate webhook returned the existing sale; one PaymentIntent session was created.'
          : `The provider was asked to create ${context.provider.sessionCharges.length} sessions.`,
        evidence: { chargesSent: context.provider.sessionCharges.length, finalStatus: repeat.order?.status ?? 'missing' },
      };
    },
  ));

  cases.push(await runCase(
    {
      caseId: 'declined-is-not-a-sale',
      title: 'A declined payment is never recorded as a sale',
      expectation: 'When the provider declines, the order must end up marked failed — never pending-looking-paid, and never shipped.',
    },
    async () => {
      const context = scripted();
      const cartId = await scriptedCart(context.carts);
      const { order } = await context.checkout.createSession({ cartId, ...REHEARSAL_ORDER_CONTEXT, ...REHEARSAL_SHIPPING_CONTEXT });
      const result = await context.provider.deliver(context.checkout, order, 'failed');
      const correct = result.order?.status === 'failed' && result.order.paymentState === 'payment_failed';
      return {
        passed: correct,
        observed: `The declined payment left the order marked "${result.order?.status ?? 'missing'}".`,
        evidence: {
          orderStatus: result.order?.status ?? 'missing',
          paymentStatus: result.order?.paymentState ?? 'missing',
        },
      };
    },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'empty-cart-refused',
      title: 'An empty cart cannot reach checkout',
      expectation: 'Opening checkout on an empty cart must be refused rather than creating a zero-value order.',
    },
    async () => {
      const context = scripted();
      const empty = await context.carts.getCart();
      return context.checkout.createSession({ cartId: empty.id, ...REHEARSAL_ORDER_CONTEXT, ...REHEARSAL_SHIPPING_CONTEXT });
    },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'client-shipping-refused',
      title: 'The browser cannot author shipping cost',
      expectation: 'A client-authored shipping amount must be refused — only a server-resolved shipping-rate id can determine the order total.',
    },
    async () => {
      const context = scripted();
      const cartId = await scriptedCart(context.carts);
      return context.checkout.createSession({
        cartId, ...REHEARSAL_ORDER_CONTEXT, ...REHEARSAL_SHIPPING_CONTEXT, shippingCents: -500,
      } as never);
    },
  ));

  // ---- Combined shipping ------------------------------------------------------
  cases.push(await runCase(
    {
      caseId: 'combined-shipping-one-box',
      title: 'Several small items ship in one box',
      expectation: 'Three small items that comfortably fit together must be packed into a single parcel — that is the whole promise of combined shipping.',
    },
    () => {
      const parcels = packItems([
        { productId: 'cup-a', length: 4, width: 4, height: 4, weightOz: 8, quantity: 1 },
        { productId: 'cup-b', length: 4, width: 4, height: 4, weightOz: 8, quantity: 1 },
        { productId: 'plate', length: 4, width: 4, height: 4, weightOz: 8, quantity: 1 },
      ]);
      const single = parcels.length === 1;
      return {
        passed: single && parcels[0]?.weightOz === 24,
        observed: single
          ? `One ${parcels[0]?.boxName ?? 'custom'} parcel at ${parcels[0]?.weightOz}oz.`
          : `Expected a single parcel, got ${parcels.length}.`,
        evidence: { parcels: parcels.length, box: parcels[0]?.boxName ?? 'custom', weightOz: parcels[0]?.weightOz ?? 0 },
      };
    },
  ));

  cases.push(await runCase(
    {
      caseId: 'heavy-order-splits',
      title: 'A too-heavy order is split rather than shipped illegally',
      expectation: `An order past the ${MAX_WEIGHT_OZ}oz carrier limit must be split across parcels, each within the limit.`,
    },
    () => {
      const parcels = packItems([
        { productId: 'heavy', length: 6, width: 6, height: 6, weightOz: 100, quantity: 10 },
      ]);
      const split = parcels.length > 1;
      const allWithinLimit = parcels.every((parcel) => parcel.weightOz <= MAX_WEIGHT_OZ);
      return {
        passed: split && allWithinLimit,
        observed: `1000oz packed into ${parcels.length} parcels (${parcels.map((parcel) => `${parcel.weightOz}oz`).join(', ')}).`,
        evidence: { parcels: parcels.length, heaviest: Math.max(...parcels.map((parcel) => parcel.weightOz)), limit: MAX_WEIGHT_OZ },
      };
    },
  ));

  cases.push(await runCase(
    {
      caseId: 'oversized-ships-alone',
      title: 'An oversized item ships on its own real dimensions',
      expectation: 'An item too big for any standard box must be quoted at its own dimensions instead of being forced into a box it cannot fit.',
    },
    () => {
      const parcels = packItems([
        { productId: 'floor-lamp', length: 30, width: 24, height: 10, weightOz: 120, quantity: 1 },
      ]);
      const [parcel] = parcels;
      const correct = parcels.length === 1 && parcel?.boxName === undefined && parcel?.length === 30;
      return {
        passed: correct,
        observed: correct
          ? 'Quoted as a single 30x24x10 parcel with no standard box forced onto it.'
          : `Expected one real-dimension parcel, got ${parcels.length} (box: ${parcel?.boxName ?? 'none'}).`,
        evidence: { parcels: parcels.length, box: parcel?.boxName ?? 'custom dimensions', weightOz: parcel?.weightOz ?? 0 },
      };
    },
  ));

  return buildRehearsalReport({
    kind: 'checkout',
    title: 'Checkout and shipping',
    cases,
    startedMs,
    now,
    caveats: [PAYMENT_CAVEAT],
  });
}
