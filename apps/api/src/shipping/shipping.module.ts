import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { CatalogModule } from '../catalog/catalog.module';
import { EasyPostClient } from './easypost.client';
import { ShippingController } from './shipping.controller';
import { ShippingService } from './shipping.service';

@Module({
  imports: [CartModule, CatalogModule],
  controllers: [ShippingController],
  providers: [
    ShippingService,
    { provide: EasyPostClient, useFactory: () => new EasyPostClient() },
  ],
  exports: [ShippingService],
})
export class ShippingModule {}
