import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { CartService, type Cart } from '../cart/cart.service';
import {
  CATALOG_SOURCE,
  type CatalogDimensions,
  type CatalogMeasurement,
  type CatalogSource,
  type CatalogVariant,
} from '../catalog/catalog.types';
import { packItems, type PackerItem } from './box-packer';
import {
  EasyPostClient,
  type EasyPostAddress,
  type EasyPostRate,
  type EasyPostShipment,
} from './easypost.client';

const RATE_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_RATE_CACHE_ENTRIES = 200;

export interface ShippingAddressInput {
  name?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  phone?: string;
}

export interface ShippingRateInput {
  cartId: string;
  address: ShippingAddressInput;
}

export interface AggregatedRate {
  /** Stable selection id shared with the checkout contract. */
  id: string;
  carrier: string;
  service: string;
  totalCents: number;
  deliveryDays: number | null;
  parcelCount: number;
  quotedAt: string;
}

interface NormalizedShippingAddress {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string;
}

interface CachedRates {
  rates: AggregatedRate[];
  expiresAt: number;
}

function optionalTrim(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeShippingAddress(input: ShippingAddressInput | undefined): NormalizedShippingAddress {
  const line1 = optionalTrim(input?.line1);
  const city = optionalTrim(input?.city);
  const state = optionalTrim(input?.state);
  const postalCode = optionalTrim(input?.postalCode);
  if (!line1 || !city || !state || !postalCode) {
    throw new BadRequestException('Complete address is required (line1, city, state, postalCode)');
  }
  return {
    name: optionalTrim(input?.name) ?? '',
    line1,
    line2: optionalTrim(input?.line2),
    city,
    state: state.toUpperCase(),
    postalCode: postalCode.toUpperCase(),
    country: (optionalTrim(input?.country) ?? 'US').toUpperCase(),
    phone: optionalTrim(input?.phone),
  };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function measurement(raw: number | CatalogMeasurement | undefined, fallbackUnit: string): { value: number; unit: string } | undefined {
  if (typeof raw === 'number') {
    const value = positiveNumber(raw);
    return value === undefined ? undefined : { value, unit: fallbackUnit };
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const value = positiveNumber(raw.value);
  return value === undefined ? undefined : { value, unit: optionalTrim(raw.unit)?.toLowerCase() ?? fallbackUnit };
}

function dimensionToInches(raw: number | CatalogMeasurement | undefined, fallback: number, sharedUnit?: string): number {
  const measured = measurement(raw, sharedUnit?.toLowerCase() ?? 'inches');
  if (!measured) return fallback;
  switch (measured.unit) {
    case 'millimeter': case 'millimeters': case 'mm': return measured.value / 25.4;
    case 'centimeter': case 'centimeters': case 'cm': return measured.value / 2.54;
    case 'meter': case 'meters': case 'm': return measured.value * 39.3701;
    case 'foot': case 'feet': case 'ft': return measured.value * 12;
    default: return measured.value;
  }
}

function weightToPounds(raw: CatalogVariant['weight'], fallback = 5): number {
  const measured = measurement(raw, 'pounds');
  if (!measured) return fallback;
  switch (measured.unit) {
    case 'milligram': case 'milligrams': case 'mg': return measured.value / 453_592.37;
    case 'gram': case 'grams': case 'g': return measured.value / 453.59237;
    case 'kilogram': case 'kilograms': case 'kg': return measured.value * 2.2046226218;
    case 'ounce': case 'ounces': case 'oz': return measured.value / 16;
    default: return measured.value;
  }
}

function packerItemFor(variant: CatalogVariant | undefined, quantity: number): PackerItem {
  const dimensions: CatalogDimensions | undefined = variant?.dimensions;
  return {
    productId: variant?.id,
    length: dimensionToInches(dimensions?.length, 14, dimensions?.unit),
    width: dimensionToInches(dimensions?.width, 10, dimensions?.unit),
    height: dimensionToInches(dimensions?.height, 6, dimensions?.unit),
    weightOz: Math.max(1, weightToPounds(variant?.weight) * 16),
    quantity,
  };
}

function toEasyPostAddress(address: NormalizedShippingAddress): EasyPostAddress {
  return {
    name: address.name,
    street1: address.line1,
    street2: address.line2,
    city: address.city,
    state: address.state,
    zip: address.postalCode,
    country: address.country,
    phone: address.phone,
  };
}

function quoteCacheKey(cart: Cart, address: NormalizedShippingAddress): string {
  const items = [...cart.items]
    .map(({ productId, quantity, priceCents }) => ({ productId, quantity, priceCents }))
    .sort((left, right) => left.productId.localeCompare(right.productId));
  return createHash('sha256')
    .update(JSON.stringify({ cartId: cart.id, cartUpdatedAt: cart.updatedAt, items, address }))
    .digest('hex');
}

function rateCents(rate: EasyPostRate): number | null {
  const dollars = Number.parseFloat(rate.rate);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

export function aggregateShipmentRates(shipments: readonly EasyPostShipment[], quotedAt: string): AggregatedRate[] {
  const ratesByKey = new Map<string, {
    totalCents: number;
    maxDays: number | null;
    carrier: string;
    service: string;
    parcelCount: number;
  }>();

  for (const shipment of shipments) {
    const cheapestPerKey = new Map<string, { rateCents: number; days: number | null; carrier: string; service: string }>();
    for (const rate of shipment.rates ?? []) {
      const carrier = optionalTrim(rate.carrier);
      const service = optionalTrim(rate.service);
      const cents = rateCents(rate);
      if (!carrier || !service || cents === null) continue;
      const key = `${carrier}:${service}`;
      const days = Number.isInteger(rate.delivery_days) && (rate.delivery_days ?? -1) >= 0
        ? rate.delivery_days
        : null;
      const existing = cheapestPerKey.get(key);
      if (!existing || cents < existing.rateCents) {
        cheapestPerKey.set(key, { rateCents: cents, days, carrier, service });
      }
    }

    for (const [key, rate] of cheapestPerKey) {
      const existing = ratesByKey.get(key);
      if (!existing) {
        ratesByKey.set(key, {
          totalCents: rate.rateCents,
          maxDays: rate.days,
          carrier: rate.carrier,
          service: rate.service,
          parcelCount: 1,
        });
        continue;
      }
      existing.totalCents += rate.rateCents;
      existing.maxDays = rate.days === null
        ? existing.maxDays
        : Math.max(existing.maxDays ?? rate.days, rate.days);
      existing.parcelCount += 1;
    }
  }

  const parcelCount = shipments.length;
  return [...ratesByKey.entries()]
    .filter(([, rate]) => rate.parcelCount === parcelCount)
    .map(([id, rate]) => ({
      id,
      carrier: rate.carrier,
      service: rate.service,
      totalCents: rate.totalCents,
      deliveryDays: rate.maxDays,
      parcelCount,
      quotedAt,
    }))
    .sort((left, right) => left.totalCents - right.totalCents || left.id.localeCompare(right.id));
}

function selectUsefulRates(sortedRates: readonly AggregatedRate[]): AggregatedRate[] {
  if (sortedRates.length <= 4) return sortedRates.map((rate) => ({ ...rate }));

  const selected: AggregatedRate[] = [sortedRates[0]];
  const used = new Set([sortedRates[0].id]);
  const fastest = [...sortedRates]
    .filter((rate) => rate.deliveryDays !== null)
    .sort((left, right) => (left.deliveryDays ?? Infinity) - (right.deliveryDays ?? Infinity)
      || left.totalCents - right.totalCents)[0];
  if (fastest && !used.has(fastest.id)) {
    selected.push(fastest);
    used.add(fastest.id);
  }
  for (const rate of sortedRates) {
    if (selected.length >= 4) break;
    if (!used.has(rate.id)) {
      selected.push(rate);
      used.add(rate.id);
    }
  }
  return selected.sort((left, right) => left.totalCents - right.totalCents).map((rate) => ({ ...rate }));
}

@Injectable()
export class ShippingService {
  private readonly logger = new Logger(ShippingService.name);
  private readonly rateCache = new Map<string, CachedRates>();

  constructor(
    @Inject(CartService) private readonly carts: CartService,
    @Inject(CATALOG_SOURCE) private readonly catalog: CatalogSource,
    @Inject(EasyPostClient) private readonly easyPost: EasyPostClient,
  ) {}

  async getRates(input: ShippingRateInput): Promise<AggregatedRate[]> {
    if (!this.easyPost.isConfigured()) {
      this.logger.warn('EASYPOST_API_KEY is not set — returning empty rates');
      return [];
    }

    const cartId = optionalTrim(input?.cartId);
    if (!cartId) throw new BadRequestException('cartId is required');
    const address = normalizeShippingAddress(input.address);
    const cart = await this.carts.findCart(cartId);
    if (!cart || cart.items.length === 0) throw new BadRequestException('Cart is empty or not found');

    const key = quoteCacheKey(cart, address);
    const cached = this.rateCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.rates.map((rate) => ({ ...rate }));

    const variants = await Promise.all(cart.items.map((item) => this.catalog.variant(item.productId)));
    const packerItems = cart.items.map((item, index) => packerItemFor(variants[index], item.quantity));
    const parcels = packItems(packerItems);
    const toAddress = toEasyPostAddress(address);

    let shipments: EasyPostShipment[];
    try {
      shipments = await Promise.all(parcels.map((parcel, index) => this.easyPost.createShipment(
        toAddress,
        { length: parcel.length, width: parcel.width, height: parcel.height, weight: parcel.weightOz },
        `cart-${cart.id}-parcel-${index}`,
      )));
    } catch (error) {
      this.logger.error(`EasyPost rate request failed: ${(error as Error)?.message ?? error}`);
      return [];
    }

    const rates = selectUsefulRates(aggregateShipmentRates(shipments, new Date().toISOString()));
    this.rateCache.set(key, { rates: rates.map((rate) => ({ ...rate })), expiresAt: Date.now() + RATE_CACHE_TTL_MS });
    this.pruneRateCache();
    return rates;
  }

  async resolveRate(input: ShippingRateInput, rateId: string): Promise<AggregatedRate> {
    const selectedId = optionalTrim(rateId);
    if (!selectedId) throw new BadRequestException('shippingRateId is required');
    const rate = (await this.getRates(input)).find((candidate) => candidate.id === selectedId);
    if (!rate) throw new BadRequestException('Shipping rate is unavailable or expired');
    return rate;
  }

  private pruneRateCache(): void {
    if (this.rateCache.size <= MAX_RATE_CACHE_ENTRIES) return;
    const now = Date.now();
    for (const [key, value] of this.rateCache) {
      if (value.expiresAt <= now) this.rateCache.delete(key);
    }
  }
}
