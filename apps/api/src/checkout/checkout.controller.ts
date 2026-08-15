import { BadRequestException, Inject, Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { BuyerOrdersService } from './buyer-orders.service';
import { CheckoutService, type CheckoutSessionInput } from './checkout.service';

@Controller('checkout')
export class CheckoutController {
  constructor(
    @Inject(CheckoutService) private readonly checkout: CheckoutService,
    @Inject(BuyerOrdersService) private readonly buyerOrders: BuyerOrdersService,
  ) {}

  @Get('orders')
  async orders(@Query('buyerId') buyerId: string) {
    return { orders: await this.buyerOrders.listForBuyer(buyerId) };
  }

  @Post('sessions')
  createSession(@Body() body: CheckoutSessionInput) {
    return this.checkout.createSession(body);
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
}
