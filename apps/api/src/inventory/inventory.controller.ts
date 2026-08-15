import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  AUCTION_INVENTORY,
  type AuctionInventory,
  type InventoryHoldSource,
} from '../auction/auction.service';
import { EventOwnershipGuard } from '../events/event-ownership.guard';
import { SyncInvalidationService } from '../sync/sync-invalidation.service';
import { DEMO_PRINCIPAL_HEADER } from '../sync/sync-request-context';
import { buyerHoldExpiresAt } from './hold-policy';

interface HoldBody {
  quantity?: number;
  sourceKind?: string;
  sourceId?: string;
}

interface SaveBody {
  quantity?: number;
  priceCents?: number;
}

const HOLD_KINDS = new Set<InventoryHoldSource['kind']>(['auction', 'event', 'cart']);

function readSource(body: HoldBody): InventoryHoldSource {
  const kind = (body.sourceKind ?? 'cart') as InventoryHoldSource['kind'];
  const id = (body.sourceId ?? '').trim();
  if (!HOLD_KINDS.has(kind)) throw new BadRequestException('sourceKind must be auction, event, or cart');
  if (!id || id.length > 120) throw new BadRequestException('sourceId is required and must be 120 characters or fewer');
  if (kind !== 'event') {
    throw new BadRequestException('The seller inventory route accepts event holds only');
  }
  return { kind, id };
}

@Controller('inventory')
export class InventoryController {
  constructor(
    @Inject(AUCTION_INVENTORY) private readonly inventory: AuctionInventory,
    @Inject(SyncInvalidationService) private readonly invalidations: SyncInvalidationService,
    @Inject(EventOwnershipGuard) private readonly ownership: EventOwnershipGuard,
  ) {}

  @Get(':productId')
  async snapshot(
    @Param('productId') productId: string,
    @Headers(DEMO_PRINCIPAL_HEADER) principal: string | undefined,
  ) {
    const sellerId = this.ownership.sellerId(principal);
    const item = await this.inventory.getOwned(productId, sellerId);
    if (!item) throw new NotFoundException(`Inventory item ${productId} was not found`);
    return item;
  }

  @Post(':productId/hold')
  async hold(
    @Param('productId') productId: string,
    @Body() body: HoldBody,
    @Headers(DEMO_PRINCIPAL_HEADER) principal: string | undefined,
  ) {
    const quantity = body.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity <= 0) throw new BadRequestException('quantity must be a positive integer');
    const source = readSource(body);
    const { sellerId } = await this.ownership.requireOwned(source.id, principal);
    if (!(await this.inventory.getOwned(productId, sellerId))) {
      throw new NotFoundException(`Inventory item ${productId} was not found`);
    }
    const expiresAt = source.kind === 'cart' ? buyerHoldExpiresAt() : undefined;
    const held = await this.inventory.reserveOwned(productId, quantity, source, sellerId, expiresAt);
    if (!held) throw new ConflictException(`Insufficient available quantity for ${productId}`);
    const snapshot = await this.inventory.getOwned(productId, sellerId);
    this.publishInventoryChange(productId, principal);
    return { held: true, quantity, source, expiresAt, snapshot };
  }

  @Post(':productId/release')
  async release(
    @Param('productId') productId: string,
    @Body() body: HoldBody,
    @Headers(DEMO_PRINCIPAL_HEADER) principal: string | undefined,
  ) {
    const source = readSource(body);
    const { sellerId } = await this.ownership.requireOwned(source.id, principal);
    if (!(await this.inventory.getOwned(productId, sellerId))) {
      throw new NotFoundException(`Inventory item ${productId} was not found`);
    }
    const released = await this.inventory.releaseOwned(productId, body.quantity ?? 1, source, sellerId);
    const snapshot = await this.inventory.getOwned(productId, sellerId);
    if (released) this.publishInventoryChange(productId, principal);
    return { released, source, snapshot };
  }

  @Put(':productId')
  async save(
    @Param('productId') productId: string,
    @Body() body: SaveBody,
    @Headers(DEMO_PRINCIPAL_HEADER) principal: string | undefined,
  ) {
    const quantity = body.quantity;
    if (!Number.isInteger(quantity) || (quantity ?? -1) < 0) {
      throw new BadRequestException('quantity must be a non-negative integer');
    }
    if (!Number.isInteger(body.priceCents) || (body.priceCents ?? -1) < 0) {
      throw new BadRequestException('priceCents must be a non-negative integer');
    }
    const sellerId = this.ownership.sellerId(principal);
    const snapshot = await this.inventory.saveOwned(
      productId,
      quantity!,
      body.priceCents!,
      sellerId,
    );
    if (!snapshot) throw new NotFoundException(`Inventory item ${productId} was not found`);
    this.publishInventoryChange(productId, principal);
    return { saved: true, quantity, priceCents: body.priceCents, snapshot };
  }

  private publishInventoryChange(productId: string, principal?: string): void {
    this.invalidations.invalidate('catalog.page');
    this.invalidations.invalidate('inventory.page');
    this.invalidations.invalidate(
      'inventory.snapshot',
      { productId },
      principal ? { principal } : undefined,
    );
  }
}
