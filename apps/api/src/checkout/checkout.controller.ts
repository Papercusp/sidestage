import { Inject, Body, Controller, Get, Post, Query } from '@nestjs/common';
import { BuyerOrdersService } from './buyer-orders.service';
import { CheckoutService } from './checkout.service';

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
  createSession(@Body() body: { cartId: string; buyerId: string; eventId: string; email?: string; shippingCents?: number }) {
    return this.checkout.createSession(body);
  }

  @Post('confirm')
  confirm(@Body() body: { orderId: string; sourceId: string }) {
    return this.checkout.confirmPayment(body);
  }
}
