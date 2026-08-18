import { useEffect, useState } from 'react';
import {
  catalogDemoDataEnabled,
  fetchCatalog,
  OFFLINE_FIXTURE,
  type CatalogVariant,
} from './catalog';
import type { ProductTone } from './components/ProductCard';
import { normalizeTranscriptFocusText } from './transcript-product-focus';
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

/**
 * Words that describe glue or a measurement rather than the product, so a
 * phrase containing one is not something a seller says to NAME the product.
 * `quot` is what a raw `&quot;` HTML entity in an imported title normalizes to.
 */
const ALIAS_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'are', 'was', 'has',
  'have', 'per', 'pack', 'set', 'into', 'onto', 'over', 'under',
]);
const ALIAS_SPEC_WORDS = new Set([
  'inch', 'inches', 'width', 'height', 'length', 'depth', 'diameter',
  'weight', 'quot', 'amp',
]);

/**
 * The title's speakable word runs: normalized exactly the way the focus
 * detector normalizes transcript text, minus stop/spec noise (dimensions,
 * part numbers, unit words, short fragments). Dropping a token BREAKS the run
 * rather than bridging it — "Drawn Cup, Open" may yield "drawn cup", but
 * removing "1616" from "JH-1616-OH Needle" must not invent "jh needle",
 * a phrase no seller can say and another product's alias could collide with.
 */
function aliasTokenRuns(title: string): string[][] {
  const runs: string[][] = [];
  let run: string[] = [];
  for (const token of normalizeTranscriptFocusText(title).split(' ')) {
    const keep =
      token.length > 2 &&
      !/\d/.test(token) &&
      !ALIAS_STOPWORDS.has(token) &&
      !ALIAS_SPEC_WORDS.has(token);
    if (keep) {
      run.push(token);
      continue;
    }
    if (run.length > 0) runs.push(run);
    run = [];
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** Every contiguous 2–3 word phrase of a title a seller could plausibly say. */
function titleNgrams(title: string): string[] {
  const grams = new Set<string>();
  for (const run of aliasTokenRuns(title)) {
    for (let size = 2; size <= 3; size += 1) {
      for (let start = 0; start + size <= run.length; start += 1) {
        grams.add(run.slice(start, start + size).join(' '));
      }
    }
  }
  return [...grams];
}

/**
 * Present catalog variants as transcript-focus options, with aliases a seller
 * actually SAYS (WI-39851). The old derivation — first-two words, last-two
 * words — could not match "let's switch to the needle roller" against a
 * twenty-word marketplace title, because "needle roller" sits mid-title.
 *
 * Aliases are now every 2–3 word title n-gram that is UNIQUE to one product
 * GROUP across this catalog. Group-scoped on purpose, both directions:
 * sibling colourways share a title, so their shared phrases stay (a phrase
 * naming the product is still discriminating across its own variants), while
 * a phrase two DIFFERENT products share — "roller bearing" in a lineup with
 * two bearings — identifies neither and is dropped, mirroring the detector's
 * own shared-weak-term rule (transcript-product-focus.ts signalTerms).
 *
 * List-level by necessity: uniqueness is a property of the catalog, not of
 * one variant, which is exactly why the per-variant predecessor got this
 * wrong.
 */
export function variantsToTranscriptOptions(
  variants: readonly CatalogVariant[],
): TranscriptProductOption[] {
  const groupsByGram = new Map<string, Set<string>>();
  const gramsByVariant = variants.map((variant) => {
    const grams = titleNgrams(variant.title);
    const group = variant.groupId ?? variant.id;
    for (const gram of grams) {
      let groups = groupsByGram.get(gram);
      if (!groups) groupsByGram.set(gram, (groups = new Set()));
      groups.add(group);
    }
    return grams;
  });
  return variants.map((variant, index) => {
    const aliases = [
      ...gramsByVariant[index].filter((gram) => groupsByGram.get(gram)?.size === 1),
      variant.brand.toLowerCase(),
    ].filter((alias, aliasIndex, all) => alias && all.indexOf(alias) === aliasIndex);
    return {
      id: variant.id,
      // Sibling colourways share a title and therefore one matching term. Carry
      // the group through so the focus detector counts products, not rows.
      groupKey: variant.groupId ?? variant.id,
      label: variant.title,
      price: `$${(variant.priceCents / 100).toFixed(2)}`,
      aliases,
      brand: variant.brand,
      productType: variant.productType,
      description: variant.description,
      color: variant.color,
      sku: variant.sku,
    };
  });
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
