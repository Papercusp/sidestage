import { describe, expect, it } from 'vitest';
import type { CatalogVariant } from './catalog';
import { variantsToTranscriptOptions } from './seller-products';
import { detectTranscriptProductFocus } from './transcript-product-focus';

const variant = (overrides: Partial<CatalogVariant> & Pick<CatalogVariant, 'id' | 'title'>): CatalogVariant => ({
  groupId: null,
  brand: 'Unbranded',
  productType: 'GENERIC',
  sku: overrides.id.toUpperCase(),
  condition: 'NEW',
  handlingDays: 1,
  priceCents: 1000,
  qty: 1,
  reservedQty: 0,
  availableQty: 1,
  ...overrides,
});

/**
 * The WI-39851 repro lineup, verbatim from the real prod event
 * (acceptance-dock-thumbnail-2026-08-14t11-15-02-068z). The owner said
 * "let's switch to the needle roller" on camera and no suggestion appeared:
 * the old alias derivation (first two words, last two words, brand) cannot
 * produce the one phrase a human actually says about a twenty-word
 * marketplace title.
 */
const LINEUP: CatalogVariant[] = [
  variant({
    id: 'a005',
    title: 'Medication Bag Heavy Canvas Nurse Med Bag Organizer Holder White',
    brand: 'Unbranded',
    productType: 'MEDICAL_SUPPLIES',
  }),
  variant({
    id: 'a006',
    title:
      'Koyo JH-1616-OH Needle Roller Bearingd Drawn Cup, Open, Oil Hole, Steel Cage, Inch, 1&quot; ID, 1-5/16&quot; OD, 1&quot; Width',
    brand: 'Koyo',
    productType: 'BEARINGS',
  }),
  variant({
    id: 'a00g',
    title: 'FAG Bearings Cylindrical Roller Bearing (NUP306-E-TVP2-C3)',
    brand: 'FAG',
    productType: 'BEARINGS',
  }),
  variant({
    id: 'a00b',
    title: 'Ess20170Us Pad Desk Draw 19X24 50Sh Rcy',
    brand: 'Esselte',
    productType: 'OFFICE_SUPPLIES',
  }),
];

describe('variantsToTranscriptOptions', () => {
  it('derives the phrase a seller actually says as an alias (WI-39851)', () => {
    const options = variantsToTranscriptOptions(LINEUP);
    const koyo = options.find((option) => option.id === 'a006')!;
    expect(koyo.aliases).toContain('needle roller');
    expect(koyo.aliases).toContain('needle roller bearingd');
  });

  it('drops a phrase two different products share, keeping only discriminating terms', () => {
    // Both bearing titles would need a shared token run to collide; prove the
    // mechanism with an explicit pair sharing "roller bearing".
    const options = variantsToTranscriptOptions([
      variant({ id: 'p1', title: 'Alpha Needle Roller Bearing Kit' }),
      variant({ id: 'p2', title: 'Beta Cylindrical Roller Bearing Kit' }),
    ]);
    const alpha = options.find((option) => option.id === 'p1')!;
    const beta = options.find((option) => option.id === 'p2')!;
    expect(alpha.aliases).toContain('needle roller');
    expect(alpha.aliases).not.toContain('roller bearing');
    expect(beta.aliases).not.toContain('roller bearing');
    expect(beta.aliases).toContain('cylindrical roller');
  });

  it('keeps a shared phrase when the sharers are colourways of ONE product group', () => {
    const options = variantsToTranscriptOptions([
      variant({ id: 'v1', groupId: 'lamp', title: 'Arc Table Lamp' }),
      variant({ id: 'v2', groupId: 'lamp', title: 'Arc Table Lamp' }),
    ]);
    for (const option of options) {
      expect(option.aliases).toContain('arc table');
      expect(option.aliases).toContain('table lamp');
      expect(option.aliases).toContain('arc table lamp');
    }
  });

  it('never bridges across removed spec noise to invent an unspeakable phrase', () => {
    const options = variantsToTranscriptOptions([
      variant({ id: 'k1', title: 'Koyo JH-1616-OH Needle Roller' }),
    ]);
    // "jh"/"1616"/"oh" are noise; the run break must prevent "koyo needle".
    expect(options[0].aliases).not.toContain('koyo needle');
    expect(options[0].aliases).toContain('needle roller');
  });

  it('end to end: the owner utterance now yields a suggestion for the needle roller', () => {
    const products = variantsToTranscriptOptions(LINEUP);
    const decision = detectTranscriptProductFocus({
      segments: [{ id: 's1', text: "let's switch to the needle roller" }],
      products,
      activeProductId: 'a005',
    });
    expect(decision.kind).toBe('suggest');
    if (decision.kind === 'suggest') {
      expect(decision.product.id).toBe('a006');
      expect(decision.reason).toBe('explicit-transition');
    }
  });

  it('end to end: a shared product type still stays ambiguous rather than guessing', () => {
    const products = variantsToTranscriptOptions(LINEUP);
    const decision = detectTranscriptProductFocus({
      segments: [{ id: 's1', text: "let's switch to the bearings" }],
      products,
      activeProductId: 'a005',
    });
    expect(decision.kind).not.toBe('suggest');
  });
});
