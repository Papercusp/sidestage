import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatModuleDuplicationWarnings,
  listModuleDuplications,
  listPinnedModuleKeys,
  moduleEvaluationCount,
  pinModuleState,
  resetPinnedModuleStateForTest,
} from './index.js';

beforeEach(() => {
  resetPinnedModuleStateForTest();
});

describe('calibration control (these must pass or every other result here is vacuous)', () => {
  it('vi.resetModules() really does produce a SECOND module record', async () => {
    // The control holds ORDINARY module-scoped state, so a genuine second module
    // record must yield a distinct identity. If this ever passes trivially (same
    // identity), the harness is no longer re-evaluating modules and the
    // "pinned state is shared" assertions below prove nothing.
    vi.resetModules();
    const first = await import('./module-scoped-control.fixture.js');
    vi.resetModules();
    const second = await import('./module-scoped-control.fixture.js');

    expect(second.CONTROL_IDENTITY).not.toBe(first.CONTROL_IDENTITY);
  });

  it('unpinned module-scoped writes are NOT visible across module records', async () => {
    vi.resetModules();
    const first = await import('./module-scoped-control.fixture.js');
    first.recordWrite();
    first.recordWrite();
    expect(first.writeCount()).toBe(2);

    vi.resetModules();
    const second = await import('./module-scoped-control.fixture.js');

    // A fresh module record starts from zero — this is the split the library exists to close.
    expect(second.writeCount()).toBe(0);
  });
});

describe('pinModuleState', () => {
  it('shares ONE state object across two module records', async () => {
    vi.resetModules();
    const first = await import('./pinned-subject.fixture.js');
    vi.resetModules();
    const second = await import('./pinned-subject.fixture.js');

    // Same object identity, unlike the control above.
    expect(second.SUBJECT_STATE).toBe(first.SUBJECT_STATE);
  });

  it('makes writes from one module record visible to the other', async () => {
    vi.resetModules();
    const first = await import('./pinned-subject.fixture.js');
    first.recordWrite();
    first.recordWrite();

    vi.resetModules();
    const second = await import('./pinned-subject.fixture.js');

    expect(second.writeCount()).toBe(2);
    second.recordWrite();
    expect(first.writeCount()).toBe(3);
  });

  it('runs init at most once no matter how many module records evaluate', () => {
    let inits = 0;
    const make = () => pinModuleState('k.init-once', () => {
      inits += 1;
      return { n: inits };
    });

    const a = make();
    const b = make();
    const c = make();

    expect(inits).toBe(1);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('keeps distinct keys independent', () => {
    const a = pinModuleState('k.a', () => ({ v: 'a' }));
    const b = pinModuleState('k.b', () => ({ v: 'b' }));

    expect(a).not.toBe(b);
    expect(moduleEvaluationCount('k.a')).toBe(1);
    expect(moduleEvaluationCount('k.b')).toBe(1);
  });

  it('rejects an empty key rather than silently sharing one global slot', () => {
    expect(() => pinModuleState('', () => ({}))).toThrow(TypeError);
  });

  it('preserves falsy and non-object state', () => {
    const zero = pinModuleState<number>('k.zero', () => 0);
    expect(zero).toBe(0);
    // The second evaluation must return the pinned 0, not re-run init.
    let reran = false;
    const again = pinModuleState<number>('k.zero', () => {
      reran = true;
      return 99;
    });
    expect(again).toBe(0);
    expect(reran).toBe(false);
  });
});

describe('duplication detection', () => {
  it('reports nothing when every key was evaluated once', () => {
    pinModuleState('k.single', () => ({}));
    expect(listModuleDuplications()).toEqual([]);
  });

  it('reports a key evaluated more than once', () => {
    pinModuleState('k.dup', () => ({}));
    pinModuleState('k.dup', () => ({}));

    const dups = listModuleDuplications();
    expect(dups).toHaveLength(1);
    expect(dups[0]!.key).toBe('k.dup');
    expect(dups[0]!.evaluations).toBe(2);
  });

  it('counts a real second module record as a duplication', async () => {
    vi.resetModules();
    await import('./pinned-subject.fixture.js');
    vi.resetModules();
    await import('./pinned-subject.fixture.js');

    expect(moduleEvaluationCount('@papercusp/module-singleton.test.pinned-subject')).toBe(2);
    expect(listModuleDuplications().map((d) => d.key)).toContain(
      '@papercusp/module-singleton.test.pinned-subject',
    );
  });

  it('sorts by evaluation count descending, then key', () => {
    pinModuleState('k.b', () => ({}));
    pinModuleState('k.b', () => ({}));
    pinModuleState('k.a', () => ({}));
    pinModuleState('k.a', () => ({}));
    pinModuleState('k.a', () => ({}));

    expect(listModuleDuplications().map((d) => [d.key, d.evaluations])).toEqual([
      ['k.a', 3],
      ['k.b', 2],
    ]);
  });

  it('distinguishes "never evaluated" (0) from "evaluated once" (1)', () => {
    // A caller must not read 0 as a healthy singleton — it means not loaded.
    expect(moduleEvaluationCount('k.never')).toBe(0);
    pinModuleState('k.once', () => ({}));
    expect(moduleEvaluationCount('k.once')).toBe(1);
  });

  it('lists pinned keys regardless of duplication', () => {
    pinModuleState('k.z', () => ({}));
    pinModuleState('k.y', () => ({}));
    expect(listPinnedModuleKeys()).toEqual(['k.y', 'k.z']);
  });

  it('names the key and the count in the warning, and calls it a packaging fault', () => {
    pinModuleState('@scope/pkg.state', () => ({}));
    pinModuleState('@scope/pkg.state', () => ({}));

    const [warning] = formatModuleDuplicationWarnings();
    expect(warning).toContain('@scope/pkg.state');
    expect(warning).toContain('2x');
    expect(warning).toMatch(/packaging fault/i);
  });

  it('formats nothing when clean', () => {
    pinModuleState('k.clean', () => ({}));
    expect(formatModuleDuplicationWarnings()).toEqual([]);
  });
});

describe('the detector cannot split the way its subjects can', () => {
  it('survives a reset of the library module itself', async () => {
    vi.resetModules();
    const first = await import('./index.js');
    first.pinModuleState('k.survives', () => ({ v: 1 }));

    vi.resetModules();
    const second = await import('./index.js');

    // A fresh module record of the LIBRARY still sees the pinned slot, because
    // the slot map lives on globalThis rather than in this module's scope.
    expect(second.moduleEvaluationCount('k.survives')).toBe(1);
    expect(second.listPinnedModuleKeys()).toContain('k.survives');
  });
});
