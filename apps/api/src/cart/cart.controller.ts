import { BadRequestException, Inject, Body, Controller, Delete, Get, Headers, Param, Patch, Post } from '@nestjs/common';
import { DEMO_PRINCIPAL_HEADER, rolePrincipal } from '../sync/sync-request-context';
import { CartService } from './cart.service';

@Controller('cart')
export class CartController {
  constructor(@Inject(CartService) private readonly carts: CartService) {}

  @Get(':id')
  getCart(
    @Param('id') id: string,
    @Headers(DEMO_PRINCIPAL_HEADER) principal?: string,
  ) {
    return this.carts.findCartForBuyer(id, this.buyerId(principal));
  }

  @Post('items')
  addItem(@Body() body: {
    cartId?: string;
    productId: string;
    title: string;
    priceCents: number;
    quantity?: number;
    imageUrl?: string;
    eventId?: string;
    eventItemId?: string;
    idempotencyKey?: string;
  }, @Headers(DEMO_PRINCIPAL_HEADER) principal?: string) {
    return this.carts.holdItemForBuyer(body, this.buyerId(principal));
  }

  @Patch(':cartId/items/:productId')
  setQuantity(
    @Param('cartId') cartId: string,
    @Param('productId') productId: string,
    @Body() body: { quantity: number },
    @Headers(DEMO_PRINCIPAL_HEADER) principal?: string,
  ) {
    return this.carts.setQuantityForBuyer(cartId, productId, body.quantity, this.buyerId(principal));
  }

  @Delete(':cartId/items/:productId')
  removeItem(
    @Param('cartId') cartId: string,
    @Param('productId') productId: string,
    @Headers(DEMO_PRINCIPAL_HEADER) principal?: string,
  ) {
    return this.carts.removeItemForBuyer(cartId, productId, this.buyerId(principal));
  }

  private buyerId(principal: unknown): string {
    const buyerId = rolePrincipal(principal, 'buyer');
    if (!buyerId) throw new BadRequestException('Buyer principal is required');
    return buyerId;
  }
}
