import { BadRequestException, Inject, Body, Controller, Get, Headers, Param, Post, Req } from '@nestjs/common';
import { DEMO_PRINCIPAL_HEADER, rolePrincipal } from '../sync/sync-request-context';
import { BuyerOrdersService } from './buyer-orders.service';
import { CheckoutService, type CheckoutSessionInput } from './checkout.service';

@Controller('checkout')
export class CheckoutController {
  constructor(
    @Inject(CheckoutService) private readonly checkout: CheckoutService,
    @Inject(BuyerOrdersService) private readonly buyerOrders: BuyerOrdersService,
  ) {}

  @Get('orders')
  async orders(@Headers(DEMO_PRINCIPAL_HEADER) principal?: string) {
    return { orders: await this.buyerOrders.listForBuyer(this.buyerId(principal)) };
  }

  @Post('sessions')
  createSession(
    @Body() body: Omit<CheckoutSessionInput, 'buyerId'> & { buyerId?: unknown },
    @Headers(DEMO_PRINCIPAL_HEADER) principal?: string,
  ) {
    return this.checkout.createSession({ ...body, buyerId: this.buyerId(principal) });
  }

  @Post('orders/:id/cancel')
  cancelOrder(
    @Param('id') id: string,
    @Headers(DEMO_PRINCIPAL_HEADER) principal?: string,
  ) {
    return this.checkout.cancelOrder(id, this.buyerId(principal));
  }

  @Post('webhook')
  webhook(@Req() request: {
    rawBody?: Buffer;
    headers: Record<string, string | string[] | undefined>;
  }) {
    if (!Buffer.isBuffer(request.rawBody)) {
      throw new BadRequestException('Stripe webhook requires the raw request body');
    }
    return this.checkout.handleWebhook(request.rawBody, request.headers['stripe-signature']);
  }

  private buyerId(principal: unknown): string {
    const buyerId = rolePrincipal(principal, 'buyer');
    if (!buyerId) throw new BadRequestException('Buyer principal is required');
    return buyerId;
  }
}
