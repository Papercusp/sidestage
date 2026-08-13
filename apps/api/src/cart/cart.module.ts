import { Module } from '@nestjs/common';
import { CartController } from './cart.controller';
import { CART_STORE, CartService, InMemoryCartStore } from './cart.service';

@Module({
  controllers: [CartController],
  providers: [
    CartService,
    InMemoryCartStore,
    { provide: CART_STORE, useExisting: InMemoryCartStore },
  ],
  exports: [CartService],
})
export class CartModule {}
