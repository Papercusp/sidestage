import { useEffect, useState } from 'react';
import {
  catalogDemoDataEnabled,
  fetchCatalog,
  OFFLINE_FIXTURE,
  type CatalogVariant,
} from './catalog';
import type { ProductTone } from './components/ProductCard';
import type { TranscriptProductOption } from './use-live-transcript';

export interface CatalogProduct {
  id: string;
  name: string;
  imageUrl?: string;
  price: string;
  compareAt?: string;
  description: string;
  badge?: string;
  stockLabel: string;
  tone: ProductTone;
  glyph: string;
}

const PRODUCT_TONES: readonly ProductTone[] = ['cyan', 'violet', 'amber'];
const PRODUCT_GLYPHS = ['◒', '⌁', '◌'] as const;

/** Present a catalog variant in the seller shell's visual vocabulary. */
export function variantToSellerProduct(variant: CatalogVariant, index: number): CatalogProduct {
  return {
    id: variant.id,
    name: variant.title,
    imageUrl: variant.imageUrl,
    price: `$${(variant.priceCents / 100).toFixed(2)}`,
    description: variant.description ?? [variant.brand, variant.color ?? variant.condition].filter(Boolean).join(' · '),
    badge: index === 0 ? 'Featured' : undefined,
    stockLabel: `${variant.availableQty} available`,
    tone: PRODUCT_TONES[index % PRODUCT_TONES.length],
    glyph: PRODUCT_GLYPHS[index % PRODUCT_GLYPHS.length],
  };
}

export function variantToTranscriptOption(variant: CatalogVariant): TranscriptProductOption {
  const words = variant.title.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  const aliases = [
    words.slice(0, 2).join(' '),
    words.slice(-2).join(' '),
    variant.brand.toLowerCase(),
  ].filter((alias, index, all) => alias && all.indexOf(alias) === index);
  return {
    id: variant.id,
    label: variant.title,
    price: `$${(variant.priceCents / 100).toFixed(2)}`,
    aliases,
    brand: variant.brand,
    productType: variant.productType,
    description: variant.description,
    color: variant.color,
    sku: variant.sku,
  };
}

export function sellerCatalogFallback(
  allowDemoData: boolean = catalogDemoDataEnabled(),
): CatalogVariant[] {
  return allowDemoData ? [...OFFLINE_FIXTURE.slice(0, 3)] : [];
}

/** The seller shell's on-stage products — the ONE catalog source (P-102). */
export function useSellerCatalog(): CatalogVariant[] {
  const [variants, setVariants] = useState<CatalogVariant[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchCatalog({ availability: 'in-stock', pageSize: 100 })
      .then((page) => {
        if (!cancelled) setVariants(page.rows);
      })
      .catch(() => {
        if (!cancelled) setVariants(sellerCatalogFallback());
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return variants;
}
