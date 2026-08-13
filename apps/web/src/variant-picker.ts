/**
 * The compact catalog contract shared by the buyer picker and live event
 * cards. `optionValueIds` are ordered by the corresponding axis position;
 * keeping that order makes the client-side signature deterministic and lets
 * the API preserve Restart's variant ids unchanged.
 */
export type VariantPickerImage = {
  url: string;
  alt?: string;
  isPrimary: boolean;
};

export type VariantPickerValue = {
  id: string;
  slug: string;
  label: string;
  position: number;
};

export type VariantPickerAxis = {
  id: string;
  slug: string;
  label: string;
  position: number;
  required: boolean;
  values: VariantPickerValue[];
};

export type VariantPickerVariant = {
  id: string;
  sku: string;
  optionValueIds: string[];
  priceCents: number;
  availableQty: number;
  images: VariantPickerImage[];
};

export type VariantPickerData = {
  productId: string;
  axes: VariantPickerAxis[];
  variants: VariantPickerVariant[];
  defaultVariantId: string | null;
};

/** The selection map is keyed by axis id and stores the selected value id. */
export type VariantSelection = Readonly<Record<string, string | undefined>>;

type AxisLookup = {
  byValueId: Map<string, { axis: VariantPickerAxis; value: VariantPickerValue }>;
};

function sortedAxes(axes: readonly VariantPickerAxis[]): VariantPickerAxis[] {
  return [...axes].sort((left, right) => left.position - right.position);
}

function buildAxisLookup(axes: readonly VariantPickerAxis[]): AxisLookup {
  const byValueId = new Map<string, { axis: VariantPickerAxis; value: VariantPickerValue }>();

  for (const axis of axes) {
    for (const value of axis.values) {
      byValueId.set(value.id, { axis, value });
    }
  }

  return { byValueId };
}

function escapeSignaturePart(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('=', '\\=');
}

/**
 * Build the same signature used by `storefront_product.option_signature`.
 * Required axes must be selected; optional axes are included only when the
 * caller selected them. A no-option product uses the Restart-compatible
 * `base` signature.
 */
export function canonicalVariantSignature(
  axes: readonly VariantPickerAxis[],
  selection: VariantSelection,
): string | null {
  const lookup = buildAxisLookup(axes);
  const segments: string[] = [];

  for (const axis of sortedAxes(axes)) {
    const valueId = selection[axis.id];
    if (!valueId) {
      if (axis.required) return null;
      continue;
    }

    const selected = lookup.byValueId.get(valueId);
    if (!selected || selected.axis.id !== axis.id) return null;
    segments.push(`${escapeSignaturePart(axis.slug)}=${escapeSignaturePart(selected.value.slug)}`);
  }

  return segments.length === 0 ? 'base' : segments.join('|');
}

function variantSignature(
  axes: readonly VariantPickerAxis[],
  variant: VariantPickerVariant,
): string | null {
  const sorted = sortedAxes(axes);
  if (variant.optionValueIds.length !== sorted.length) {
    return sorted.length === 0 && variant.optionValueIds.length === 0 ? 'base' : null;
  }

  const selection: Record<string, string> = {};
  for (let index = 0; index < sorted.length; index += 1) {
    selection[sorted[index].id] = variant.optionValueIds[index];
  }
  return canonicalVariantSignature(axes, selection);
}

/** Build an O(1) signature index for repeated picker resolution. */
export function indexVariants(data: VariantPickerData): ReadonlyMap<string, VariantPickerVariant> {
  const indexed = new Map<string, VariantPickerVariant>();
  for (const variant of data.variants) {
    const signature = variantSignature(data.axes, variant);
    if (signature) indexed.set(signature, variant);
  }
  return indexed;
}

/** Resolve a complete selection without silently falling back to another SKU. */
export function resolveVariant(
  data: VariantPickerData,
  selection: VariantSelection,
): VariantPickerVariant | null {
  const signature = canonicalVariantSignature(data.axes, selection);
  if (!signature) return null;
  return indexVariants(data).get(signature) ?? null;
}

function variantMatchesSelection(
  data: VariantPickerData,
  variant: VariantPickerVariant,
  selection: VariantSelection,
  candidateAxisId?: string,
  candidateValueId?: string,
): boolean {
  const axes = sortedAxes(data.axes);
  if (variant.optionValueIds.length !== axes.length) return axes.length === 0;

  for (let index = 0; index < axes.length; index += 1) {
    const axis = axes[index];
    const expected = axis.id === candidateAxisId
      ? candidateValueId
      : selection[axis.id];
    if (expected && variant.optionValueIds[index] !== expected) return false;
  }
  return true;
}

/**
 * Return value ids that still have at least one in-stock compatible variant.
 * A complete zero-stock selection remains resolvable, but its value is false
 * here so a control can render it disabled instead of choosing another SKU.
 */
export function availableValueIds(
  data: VariantPickerData,
  selection: VariantSelection,
  axisId: string,
): ReadonlySet<string> {
  const axis = data.axes.find((candidate) => candidate.id === axisId);
  if (!axis) return new Set<string>();

  const available = new Set<string>();
  for (const value of axis.values) {
    if (data.variants.some((variant) =>
      variant.availableQty > 0
      && variantMatchesSelection(data, variant, selection, axisId, value.id))) {
      available.add(value.id);
    }
  }
  return available;
}

export function isValueAvailable(
  data: VariantPickerData,
  selection: VariantSelection,
  axisId: string,
  valueId: string,
): boolean {
  return availableValueIds(data, selection, axisId).has(valueId);
}

/** Return a default variant id while preserving an explicitly supplied zero-stock default. */
export function defaultVariant(data: VariantPickerData): VariantPickerVariant | null {
  if (data.defaultVariantId) {
    const explicit = data.variants.find((variant) => variant.id === data.defaultVariantId);
    if (explicit) return explicit;
  }
  return data.variants.find((variant) => variant.availableQty > 0) ?? data.variants[0] ?? null;
}

/** Convert a variant row into the axis-id keyed selection expected by the UI. */
export function selectionForVariant(
  data: VariantPickerData,
  variantId: string,
): VariantSelection | null {
  const variant = data.variants.find((candidate) => candidate.id === variantId);
  if (!variant) return null;

  const axes = sortedAxes(data.axes);
  if (variant.optionValueIds.length !== axes.length) return axes.length === 0 ? {} : null;
  return Object.fromEntries(axes.map((axis, index) => [axis.id, variant.optionValueIds[index]]));
}
