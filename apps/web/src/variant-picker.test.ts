import { describe, expect, it } from 'vitest';

import {
  availableValueIds,
  canonicalVariantSignature,
  defaultVariant,
  indexVariants,
  isValueAvailable,
  resolveVariant,
  selectionForVariant,
  type VariantPickerData,
} from './variant-picker';

const HOODIE: VariantPickerData = {
  productId: 'linen-hoodie',
  axes: [
    {
      id: 'color-axis',
      slug: 'color',
      label: 'Color',
      position: 0,
      required: true,
      values: [
        { id: 'red', slug: 'red', label: 'Red', position: 0 },
        { id: 'blue', slug: 'blue', label: 'Blue', position: 1 },
      ],
    },
    {
      id: 'size-axis',
      slug: 'size',
      label: 'Size',
      position: 1,
      required: true,
      values: [
        { id: 'small', slug: 's', label: 'S', position: 0 },
        { id: 'medium', slug: 'm', label: 'M', position: 1 },
      ],
    },
  ],
  variants: [
    { id: 'red-s', sku: 'RED-S', optionValueIds: ['red', 'small'], priceCents: 6800, availableQty: 7, images: [] },
    { id: 'red-m', sku: 'RED-M', optionValueIds: ['red', 'medium'], priceCents: 6800, availableQty: 0, images: [] },
    { id: 'blue-s', sku: 'BLUE-S', optionValueIds: ['blue', 'small'], priceCents: 6800, availableQty: 3, images: [] },
    { id: 'blue-m', sku: 'BLUE-M', optionValueIds: ['blue', 'medium'], priceCents: 6800, availableQty: 4, images: [] },
  ],
  defaultVariantId: 'red-s',
};

describe('variant picker data helpers', () => {
  it('builds the stable Restart signature in axis order', () => {
    expect(canonicalVariantSignature(HOODIE.axes, {
      'size-axis': 'medium',
      'color-axis': 'blue',
    })).toBe('color=blue|size=m');
    expect(canonicalVariantSignature(HOODIE.axes, { 'color-axis': 'blue' })).toBeNull();
    expect(indexVariants(HOODIE).get('color=blue|size=m')?.id).toBe('blue-m');
  });

  it('resolves a complete zero-stock selection without changing its SKU', () => {
    const selected = resolveVariant(HOODIE, { 'color-axis': 'red', 'size-axis': 'medium' });
    expect(selected?.id).toBe('red-m');
    expect(selected?.availableQty).toBe(0);
    expect(isValueAvailable(HOODIE, { 'color-axis': 'red' }, 'size-axis', 'medium')).toBe(false);
  });

  it('disables only values with no in-stock compatible variant', () => {
    expect(availableValueIds(HOODIE, {}, 'color-axis')).toEqual(new Set(['red', 'blue']));
    expect(availableValueIds(HOODIE, { 'color-axis': 'red' }, 'size-axis')).toEqual(new Set(['small']));
    expect(availableValueIds(HOODIE, { 'size-axis': 'medium' }, 'color-axis')).toEqual(new Set(['blue']));
  });

  it('supports a no-option base product and an explicit default', () => {
    const base: VariantPickerData = {
      productId: 'woven-market-tote',
      axes: [],
      variants: [{ id: 'tote-base', sku: 'TOTE', optionValueIds: [], priceCents: 4200, availableQty: 0, images: [] }],
      defaultVariantId: 'tote-base',
    };
    expect(resolveVariant(base, {} )?.id).toBe('tote-base');
    expect(defaultVariant(base)?.id).toBe('tote-base');
    expect(selectionForVariant(base, 'tote-base')).toEqual({});
  });

  it('returns an in-stock fallback when no default was supplied', () => {
    expect(defaultVariant({ ...HOODIE, defaultVariantId: null })?.id).toBe('red-s');
    expect(selectionForVariant(HOODIE, 'missing')).toBeNull();
  });
});
