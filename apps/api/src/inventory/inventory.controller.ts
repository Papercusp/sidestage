import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  AUCTION_INVENTORY,
  type AuctionInventory,
  type InventoryHoldSource,
} from '../auction/auction.service';

interface HoldBody {
  quantity?: number;
  sourceKind?: string;
  sourceId?: string;
}

const HOLD_KINDS = new Set<InventoryHoldSource['kind']>(['auction', 'event', 'cart']);

function readSource(body: HoldBody): InventoryHoldSource {
  const kind = (body.sourceKind ?? 'cart') as InventoryHoldSource['kind'];
  const id = (body.sourceId ?? '').trim();
  if (!HOLD_KINDS.has(kind)) throw new BadRequestException('sourceKind must be auction, event, or cart');
  if (!id || id.length > 120) throw new BadRequestException('sourceId is required and must be 120 characters or fewer');
  return { kind, id };
}

@Controller('inventory')
export class InventoryController {
  constructor(@Inject(AUCTION_INVENTORY) private readonly inventory: AuctionInventory) {}

  @Get(':productId')
  async snapshot(@Param('productId') productId: string) {
    const item = await this.inventory.get(productId);
    if (!item) throw new NotFoundException(`Inventory item ${productId} was not found`);
    return item;
  }

  @Post(':productId/hold')
  async hold(@Param('productId') productId: string, @Body() body: HoldBody) {
    const quantity = body.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('quantity must be a positive integer');
    const source = readSource(body);
    const held = await this.inventory.reserve(productId, quantity, source);
    if (!held) throw new ConflictException(`Insufficient available quantity for ${productId}`);
    const snapshot = await this.inventory.get(productId);
    return { held: true, quantity, source, snapshot };
  }

  @Post(':productId/release')
  async release(@Param('productId') productId: string, @Body() body: HoldBody) {
    const source = readSource(body);
    const released = await this.inventory.release(productId, body.quantity ?? 1, source);
    const snapshot = await this.inventory.get(productId);
    return { released, source, snapshot };
  }
}
