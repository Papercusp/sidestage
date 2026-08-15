import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import type {
  PaymentProvider,
  PaymentSession,
  StripeMode,
  StripePaymentEvent,
} from './checkout.service';

export interface StripeProviderConfig {
  secretKey?: string;
  publishableKey?: string;
  webhookSecret?: string;
}

interface StripePaymentIntentsApi {
  create(
    params: Stripe.PaymentIntentCreateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.PaymentIntent>;
  update(
    id: string,
    params: Stripe.PaymentIntentUpdateParams,
    options?: Stripe.RequestOptions,
  ): Promise<Stripe.PaymentIntent>;
}

interface StripeWebhooksApi {
  constructEvent(
    payload: string | Buffer,
    signature: string | string[],
    secret: string,
  ): Stripe.Event;
}

export interface StripeClient {
  paymentIntents: StripePaymentIntentsApi;
  webhooks: StripeWebhooksApi;
}

const CREATE_IDEMPOTENCY_PREFIX = 'sidestage:payment-intent:';

function stripeMode(key: string, kind: 'secret' | 'publishable'): StripeMode {
  const testPrefix = kind === 'secret' ? 'sk_test_' : 'pk_test_';
  const livePrefix = kind === 'secret' ? 'sk_live_' : 'pk_live_';
  if (key.startsWith(testPrefix)) return 'test';
  if (key.startsWith(livePrefix)) return 'live';
  throw new Error(`STRIPE_${kind === 'secret' ? 'SECRET_KEY' : 'PUBLISHABLE_KEY'} must be a Stripe test or live key`);
}

function updateIdempotencyKey(input: {
  orderId: string;
  amountCents: number;
  currency: string;
  buyerId: string;
  sourceKind: string;
  sourceId: string;
}): string {
  const revision = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 24);
  return `${CREATE_IDEMPOTENCY_PREFIX}${input.orderId}:update:${revision}`;
}

/**
 * SideStage's single runtime payment provider. Configuration and the SDK client
 * are resolved lazily so clean clones and tests can boot without Stripe keys.
 */
export class StripePaymentProvider implements PaymentProvider {
  private client: StripeClient | null = null;

  constructor(
    private readonly config: StripeProviderConfig = {},
    private readonly injectedClient?: StripeClient,
  ) {}

  async createSession(input: Parameters<PaymentProvider['createSession']>[0]): Promise<PaymentSession> {
    const secretKey = this.config.secretKey ?? process.env.STRIPE_SECRET_KEY;
    const publishableKey = this.config.publishableKey ?? process.env.STRIPE_PUBLISHABLE_KEY;
    if (!secretKey || !publishableKey) {
      return {
        provider: 'stripe',
        mode: null,
        status: 'needs-configuration',
        publishableKey: publishableKey ?? null,
        clientSecret: null,
        paymentIntentId: input.paymentIntentId ?? null,
        orderId: input.orderId,
        amountCents: input.amountCents,
        currency: input.currency,
      };
    }
    if (!Number.isInteger(input.amountCents) || input.amountCents < 50) {
      throw new BadRequestException('Stripe payments must be at least 50 cents');
    }

    const secretMode = stripeMode(secretKey, 'secret');
    const publishableMode = stripeMode(publishableKey, 'publishable');
    if (secretMode !== publishableMode) {
      throw new Error('STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY must use the same test/live mode');
    }

    const metadata = {
      orderId: input.orderId,
      buyerId: input.buyerId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
    };
    const baseParams = {
      amount: input.amountCents,
      metadata,
      ...(input.email ? { receipt_email: input.email } : {}),
    };
    const stripe = this.stripe(secretKey);
    const intent = input.paymentIntentId
      ? await stripe.paymentIntents.update(
          input.paymentIntentId,
          baseParams,
          { idempotencyKey: updateIdempotencyKey(input) },
        )
      : await stripe.paymentIntents.create(
          {
            ...baseParams,
            currency: input.currency.toLowerCase(),
            automatic_payment_methods: { enabled: true },
          },
          { idempotencyKey: `${CREATE_IDEMPOTENCY_PREFIX}${input.orderId}` },
        );

    this.assertIntentMatches(input, intent);
    if (!intent.client_secret) throw new Error(`Stripe PaymentIntent ${intent.id} did not return a client secret`);
    return {
      provider: 'stripe',
      mode: secretMode,
      status: 'ready',
      publishableKey,
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      orderId: input.orderId,
      amountCents: input.amountCents,
      currency: input.currency,
    };
  }

  async parseWebhook(
    rawBody: Buffer,
    signature: string | string[] | undefined,
  ): Promise<StripePaymentEvent | null> {
    const secretKey = this.config.secretKey ?? process.env.STRIPE_SECRET_KEY;
    const webhookSecret = this.config.webhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
    if (!secretKey || !webhookSecret) throw new BadRequestException('Stripe webhook is not configured');
    if (!signature || (Array.isArray(signature) && signature.length === 0)) {
      throw new BadRequestException('Stripe-Signature header is required');
    }

    let event: Stripe.Event;
    try {
      event = this.stripe(secretKey).webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown verification error';
      throw new BadRequestException(`Stripe webhook verification failed: ${message}`);
    }

    const type = event.type === 'payment_intent.succeeded'
      ? 'succeeded'
      : event.type === 'payment_intent.payment_failed'
        ? 'failed'
        : event.type === 'payment_intent.processing'
          ? 'processing'
          : null;
    if (!type) return null;

    const intent = event.data.object as Stripe.PaymentIntent;
    return {
      id: event.id,
      created: event.created,
      type,
      mode: event.livemode ? 'live' : 'test',
      paymentIntentId: intent.id,
      orderId: intent.metadata.orderId ?? '',
      buyerId: intent.metadata.buyerId ?? '',
      sourceKind: intent.metadata.sourceKind ?? '',
      sourceId: intent.metadata.sourceId ?? '',
      amountCents: intent.amount,
      amountReceivedCents: type === 'succeeded' ? intent.amount_received : undefined,
      currency: intent.currency.toUpperCase(),
      errorMessage: type === 'failed'
        ? intent.last_payment_error?.message ?? 'Payment failed'
        : undefined,
    };
  }

  private stripe(secretKey: string): StripeClient {
    if (this.injectedClient) return this.injectedClient;
    if (!this.client) this.client = new Stripe(secretKey);
    return this.client;
  }

  private assertIntentMatches(
    input: Parameters<PaymentProvider['createSession']>[0],
    intent: Stripe.PaymentIntent,
  ): void {
    const mismatches: string[] = [];
    if (intent.amount !== input.amountCents) mismatches.push('amount');
    if (intent.currency.toUpperCase() !== input.currency) mismatches.push('currency');
    if (intent.metadata.orderId !== input.orderId) mismatches.push('orderId');
    if (intent.metadata.buyerId !== input.buyerId) mismatches.push('buyerId');
    if (intent.metadata.sourceKind !== input.sourceKind) mismatches.push('sourceKind');
    if (intent.metadata.sourceId !== input.sourceId) mismatches.push('sourceId');
    if (mismatches.length > 0) {
      throw new BadRequestException(`Stripe PaymentIntent disagrees with SideStage order: ${mismatches.join(', ')}`);
    }
  }
}
