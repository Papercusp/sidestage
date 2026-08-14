import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  InMemoryRunOfShowStore,
  RunOfShowService,
  emptyRunOfShow,
  type RunOfShowEntry,
} from './run-of-show.service';

const EVENT_ID = 'demo-event';

function entry(overrides: Partial<RunOfShowEntry> = {}): RunOfShowEntry {
  return { productId: 'aurora-cup', plannedDurationSec: 300, notes: 'Lead with the glaze story.', ...overrides };
}

describe('RunOfShowService', () => {
  let svc: RunOfShowService;

  beforeEach(() => {
    svc = new RunOfShowService(new InMemoryRunOfShowStore());
  });

  it('defaults to an empty plan for an event never planned', async () => {
    const plan = await svc.get(EVENT_ID);
    expect(plan.eventId).toBe(EVENT_ID);
    expect(plan.entries).toEqual([]);
    expect(emptyRunOfShow(EVENT_ID).entries).toEqual([]);
  });

  it('round-trips a saved plan, preserving entry order', async () => {
    const entries = [
      entry({ productId: 'first', plannedDurationSec: 120, notes: 'open strong' }),
      entry({ productId: 'second', plannedDurationSec: null, notes: '' }),
      entry({ productId: 'third', plannedDurationSec: 600, notes: 'close with the bundle' }),
    ];
    const saved = await svc.save(EVENT_ID, { entries });
    expect(saved.entries.map((e) => e.productId)).toEqual(['first', 'second', 'third']);
    const read = await svc.get(EVENT_ID);
    expect(read.entries).toEqual(entries);
    expect(Date.parse(read.updatedAt)).toBeGreaterThan(0);
  });

  it('a re-save replaces the whole document (reorder + removal are the same save)', async () => {
    await svc.save(EVENT_ID, { entries: [entry({ productId: 'a' }), entry({ productId: 'b' })] });
    await svc.save(EVENT_ID, { entries: [entry({ productId: 'b', notes: 'moved up' })] });
    const read = await svc.get(EVENT_ID);
    expect(read.entries.map((e) => e.productId)).toEqual(['b']);
    expect(read.entries[0]!.notes).toBe('moved up');
  });

  it('treats an omitted entries field as clearing the plan', async () => {
    await svc.save(EVENT_ID, { entries: [entry()] });
    const cleared = await svc.save(EVENT_ID, {});
    expect(cleared.entries).toEqual([]);
  });

  it('normalizes missing plannedDurationSec and notes', async () => {
    const saved = await svc.save(EVENT_ID, { entries: [{ productId: 'bare' }] });
    expect(saved.entries[0]).toEqual({ productId: 'bare', plannedDurationSec: null, notes: '' });
  });

  describe('rejects', () => {
    const bad: Array<[string, unknown]> = [
      ['a non-array entries', { entries: 'nope' }],
      ['a non-object entry', { entries: [42] }],
      ['a missing productId', { entries: [{ notes: 'x' }] }],
      ['a blank productId', { entries: [{ productId: '   ' }] }],
      ['a duplicate productId', { entries: [{ productId: 'dup' }, { productId: 'dup' }] }],
      ['a zero duration', { entries: [{ productId: 'p', plannedDurationSec: 0 }] }],
      ['a negative duration', { entries: [{ productId: 'p', plannedDurationSec: -5 }] }],
      ['a fractional duration', { entries: [{ productId: 'p', plannedDurationSec: 1.5 }] }],
      ['a duration past 4 hours', { entries: [{ productId: 'p', plannedDurationSec: 4 * 3600 + 1 }] }],
      ['non-string notes', { entries: [{ productId: 'p', notes: 7 }] }],
      ['notes past the cap', { entries: [{ productId: 'p', notes: 'n'.repeat(2001) }] }],
    ];
    for (const [label, input] of bad) {
      it(label, async () => {
        await expect(svc.save(EVENT_ID, input as { entries?: unknown })).rejects.toBeInstanceOf(BadRequestException);
      });
    }

    it('an invalid eventId on both read and write', async () => {
      await expect(svc.get('Bad Event!')).rejects.toBeInstanceOf(BadRequestException);
      await expect(svc.save('Bad Event!', {})).rejects.toBeInstanceOf(BadRequestException);
    });

    it('more entries than the cap', async () => {
      const entries = Array.from({ length: 201 }, (_, i) => ({ productId: `p-${i}` }));
      await expect(svc.save(EVENT_ID, { entries })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
