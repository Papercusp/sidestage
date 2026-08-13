import { Body, Controller, Post } from '@nestjs/common';
import { packItems, type PackerItem } from './box-packer';

@Controller('shipping')
export class ShippingController {
  @Post('pack')
  pack(@Body() body: { items: PackerItem[] }) {
    return { parcels: packItems(body.items ?? []) };
  }
}
