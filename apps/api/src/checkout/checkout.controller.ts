import { Inject, Body, Controller, Post } from '@nestjs/common';
import { CheckoutService } from './checkout.service';

@Controller('checkout')
export class CheckoutController {
  constructor(@Inject(CheckoutService) private readonly checkout: CheckoutService) {}

  @Post('sessions')
  createSession(@Body() body: { cartId: string; email?: string; shippingCents?: number }) {
    return this.checkout.createSession(body);
  }

  @Post('confirm')
  confirm(@Body() body: { orderId: string; sourceId: string }) {
    return this.checkout.confirmPayment(body);
  }
}
