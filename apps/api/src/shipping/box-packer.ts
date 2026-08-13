export interface StandardBox {
  name: string;
  length: number;
  width: number;
  height: number;
}

export interface PackerItem {
  productId?: string;
  length: number;
  width: number;
  height: number;
  weightOz: number;
  quantity: number;
}

export interface Parcel {
  boxName?: string;
  length: number;
  width: number;
  height: number;
  weightOz: number;
}

export const MAX_WEIGHT_OZ = 800;
export const VOLUME_PADDING = 1.2;
export const STANDARD_BOXES: readonly StandardBox[] = [
  { name: '8x6x4', length: 8, width: 6, height: 4 },
  { name: '12x10x4', length: 12, width: 10, height: 4 },
  { name: '14x12x6', length: 14, width: 12, height: 6 },
  { name: '18x14x6', length: 18, width: 14, height: 6 },
  { name: '20x16x8', length: 20, width: 16, height: 8 },
  { name: '28x20x8', length: 28, width: 20, height: 8 },
];

function volume(item: Pick<PackerItem, 'length' | 'width' | 'height'>): number {
  return item.length * item.width * item.height;
}

function dimensionsFit(item: PackerItem, box: StandardBox): boolean {
  const itemDims = [item.length, item.width, item.height].sort((a, b) => a - b);
  const boxDims = [box.length, box.width, box.height].sort((a, b) => a - b);
  return itemDims.every((dimension, index) => dimension <= boxDims[index]);
}

function assertItem(item: PackerItem): void {
  if (![item.length, item.width, item.height, item.weightOz].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Package dimensions and weight must be positive numbers');
  }
  if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new Error('Package quantity must be a positive integer');
}

function smallestBoxForVolume(paddedVolume: number): StandardBox {
  return STANDARD_BOXES.find((box) => volume(box) >= paddedVolume) ?? STANDARD_BOXES[STANDARD_BOXES.length - 1];
}

/**
 * Port of Restart's deterministic volume/weight packer. It keeps oversized
 * units as real-dimension parcels and uses first-fit decreasing for normal
 * units, which makes checkout estimates stable and cheap without EasyPost.
 */
export function packItems(items: readonly PackerItem[]): Parcel[] {
  items.forEach(assertItem);
  const units = items.flatMap((item) => Array.from({ length: item.quantity }, () => ({ item, volume: volume(item) })));
  const largestBox = STANDARD_BOXES[STANDARD_BOXES.length - 1];
  const oversized = units.filter(({ item }) => !dimensionsFit(item, largestBox));
  const normal = units.filter(({ item }) => dimensionsFit(item, largestBox)).sort((a, b) => b.volume - a.volume);
  const parcels: Parcel[] = oversized.map(({ item }) => ({ length: item.length, width: item.width, height: item.height, weightOz: Math.max(1, Math.round(item.weightOz)) }));
  const bins: Array<{ paddedVolume: number; weightOz: number }> = [];

  for (const unit of normal) {
    const paddedVolume = unit.volume * VOLUME_PADDING;
    const bin = bins.find((candidate) => candidate.paddedVolume + paddedVolume <= volume(largestBox) && candidate.weightOz + unit.item.weightOz <= MAX_WEIGHT_OZ);
    if (bin) {
      bin.paddedVolume += paddedVolume;
      bin.weightOz += unit.item.weightOz;
    } else {
      bins.push({ paddedVolume, weightOz: unit.item.weightOz });
    }
  }

  return parcels.concat(bins.map((bin) => {
    const box = smallestBoxForVolume(bin.paddedVolume);
    return { boxName: box.name, length: box.length, width: box.width, height: box.height, weightOz: Math.max(1, Math.round(bin.weightOz)) };
  }));
}
