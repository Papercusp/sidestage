import { describe, expect, it } from 'vitest';
import { packItems } from './box-packer';

describe('packItems', () => {
  it('returns no parcel for an empty cart', () => {
    expect(packItems([])).toEqual([]);
  });

  it('chooses a standard box and preserves a positive shipping weight', () => {
    const [parcel] = packItems([{ length: 6, width: 4, height: 2, weightOz: 10, quantity: 1 }]);
    expect(parcel.boxName).toBe('8x6x4');
    expect(parcel.weightOz).toBe(10);
    expect(parcel.usedVolumeIn3).toBeCloseTo(57.6);
    expect(parcel.capacityVolumeIn3).toBe(192);
    expect(parcel.fillPercent).toBe(30);
  });

  it('splits heavy units at the 50 pound parcel ceiling', () => {
    const parcels = packItems([{ length: 10, width: 8, height: 4, weightOz: 500, quantity: 2 }]);
    expect(parcels).toHaveLength(2);
    expect(parcels.every((parcel) => parcel.weightOz <= 800)).toBe(true);
  });

  it('ships a unit that cannot fit the largest box at actual dimensions', () => {
    const [parcel] = packItems([{ length: 40, width: 10, height: 10, weightOz: 100, quantity: 1 }]);
    expect(parcel.boxName).toBeUndefined();
    expect(parcel.length).toBe(40);
    expect(parcel.weightOz).toBe(100);
    expect(parcel.fillPercent).toBe(100);
  });

  it('rejects malformed package input', () => {
    expect(() => packItems([{ length: 0, width: 4, height: 2, weightOz: 10, quantity: 1 }])).toThrow('positive');
  });
});
