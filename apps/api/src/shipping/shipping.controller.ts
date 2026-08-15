import { BadRequestException, Body, Controller, Headers, Inject, Post } from '@nestjs/common';
import { DEMO_PRINCIPAL_HEADER, rolePrincipal } from '../sync/sync-request-context';
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
  getRates(
    @Body() body: ShippingRateInput,
    @Headers(DEMO_PRINCIPAL_HEADER) principal?: string,
  ) {
    return this.shipping.getRatesForBuyer(body, this.buyerId(principal));
  }

  private buyerId(principal: unknown): string {
    const buyerId = rolePrincipal(principal, 'buyer');
    if (!buyerId) throw new BadRequestException('Buyer principal is required');
    return buyerId;
  }
}
