import { Inject, Body, Controller, Get, Param, Patch, Post, Delete } from '@nestjs/common';
import { CartService } from './cart.service';

@Controller('cart')
export class CartController {
  constructor(@Inject(CartService) private readonly carts: CartService) {}

  @Get(':id')
  getCart(@Param('id') id: string) {
    return this.carts.findCart(id);
  }

  @Post('items')
  addItem(@Body() body: {
    cartId?: string;
    productId: string;
    title: string;
    priceCents: number;
    quantity?: number;
    imageUrl?: string;
  }) {
    return this.carts.addItem(body);
  }

  @Patch(':cartId/items/:productId')
  setQuantity(@Param('cartId') cartId: string, @Param('productId') productId: string, @Body() body: { quantity: number }) {
    return this.carts.setQuantity(cartId, productId, body.quantity);
  }

  @Delete(':cartId/items/:productId')
  removeItem(@Param('cartId') cartId: string, @Param('productId') productId: string) {
    return this.carts.removeItem(cartId, productId);
  }
}
