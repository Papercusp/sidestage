import { Body, Controller, Inject, Post } from '@nestjs/common';
import { packItems, type PackerItem } from './box-packer';
import { ShippingService, type ShippingRateInput } from './shipping.service';

@Controller('shipping')
export class ShippingController {
  constructor(@Inject(ShippingService) private readonly shipping: ShippingService) {}

  @Post('pack')
  pack(@Body() body: { items: PackerItem[] }) {
    return { parcels: packItems(body.items ?? []) };
  }

  @Post('rates')
  getRates(@Body() body: ShippingRateInput) {
    return this.shipping.getRates(body);
  }
}
