import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Recurrence guard for the "a new export strands N hand-listed vi.mock
 * factories" class.
 *
 * THE CLASS. `vi.mock('<mod>', () => ({ ... }))` is a FULL-REPLACEMENT factory:
 * it must enumerate every export the subject imports. So adding ANY export to a
 * module — or, far more commonly here, moving ONE call site to a hook the
 * subject did not import before — silently strands every such factory. The
 * failure names the MOCK, not your change ("No 'useRestSyncQuery' export is
 * defined on the @papercusp/sync mock"), lands in files that never mention the
 * query you touched, and drags a cascading "TypeError: unmount is not a
 * function" through afterEach that reads as a React-testing bug. Measured
 * 2026-08-18 (WI-39855): five call-site swaps for events.guide/events.mine cost
 * 13 reds across two such files.
 *
 * THE SAFE FORM is to spread the real module and override only what the test
 * controls — immune to new exports BY CONSTRUCTION:
 *
 *   vi.mock('@papercusp/sync', async (importOriginal) => ({
 *     ...(await importOriginal<typeof import('@papercusp/sync')>()),
 *     useSyncQuery: () => ({ data: [], loading: false, error: null }),
 *   }));
 *
 * WHY THIS IS SCOPED TO ONE MODULE, not a blanket rule. A tree-wide ban would
 * have to allowlist every legitimately-replaced module in the suite, and an
 * ignored guard misses the real one. `@papercusp/sync` earns its entry: it is
 * the module whose export surface grows every time a query is de-synced onto
 * `useRestSyncQuery`, which WI-39867 says will keep happening. Add a module
 * here only after it has actually cost an incident, and convert its existing
 * mockers in the same change.
 */
const GUARDED_MODULE = '@papercusp/sync';

const sourceRoot = fileURLToPath(new URL('.', import.meta.url));

type MockForm = 'spread' | 'full-replacement';

/**
 * Classify every `vi.mock('<GUARDED_MODULE>', …)` factory in one file's source.
 *
 * A factory counts as `spread` only when it BOTH takes the importOriginal
 * parameter AND actually spreads the awaited original — an async factory that
 * ignores its parameter is still a full replacement, and would otherwise pass
 * by looking modern.
 *
 * Both idioms in this tree are accepted, because rejecting one would be a false
 * positive that trains people to weaken the guard:
 *   expression body — `async (o) => ({ ...(await o<…>()), … })`
 *   block body      — `async (o) => { const actual = await o<…>(); return { ...actual, … }; }`
 */
export function classifySyncMocks(source: string): MockForm[] {
  const forms: MockForm[] = [];
  const opener = `vi.mock('${GUARDED_MODULE}'`;
  for (let at = source.indexOf(opener); at !== -1; at = source.indexOf(opener, at + 1)) {
    const window = source.slice(at, at + 500);
    const head = /,\s*async\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>/.exec(window);
    forms.push(head && spreadsOriginal(window, head[1]) ? 'spread' : 'full-replacement');
  }
  return forms;
}

/** Does this factory actually spread the awaited original, by either idiom? */
function spreadsOriginal(window: string, param: string): boolean {
  if (new RegExp(String.raw`\.\.\.\s*\(\s*await\s+${param}\b`).test(window)) return true;
  const bound = new RegExp(String.raw`(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+${param}\b`).exec(window);
  return Boolean(bound && new RegExp(String.raw`\.\.\.\s*${bound[1]}\b`).test(window));
}

function listTestSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return listTestSources(absolute);
    if (!entry.isFile() || !/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) return [];
    return [absolute];
  });
}

describe(`vi.mock('${GUARDED_MODULE}') contract`, () => {
  /**
   * The analyzer's teeth, proven on literal fixtures rather than by mutating a
   * tracked file: a shared checkout is swept into commits every few minutes, so
   * a mutate-and-restore probe can be committed even when nothing goes wrong.
   * These live here permanently so the guard below can never pass because the
   * classifier stopped classifying.
   */
  it('flags the unsafe factory form and clears the safe one', () => {
    const unsafe = `vi.mock('${GUARDED_MODULE}', () => ({ useSyncQuery: () => ({ data: [] }) }));`;
    const safe = [
      `vi.mock('${GUARDED_MODULE}', async (importOriginal) => ({`,
      `  ...(await importOriginal<typeof import('${GUARDED_MODULE}')>()),`,
      '  useSyncQuery: () => ({ data: [] }),',
      '}));',
    ].join('\n');
    // An async factory that never spreads its original is still a full
    // replacement — the case a naive "does it say async?" check would miss.
    const asyncButNotSpread = `vi.mock('${GUARDED_MODULE}', async (importOriginal) => ({ useSyncQuery: () => ({ data: [] }) }));`;

    // The block-body idiom is equally safe and equally present in this tree;
    // flagging it would be a false positive, which is how a guard gets weakened.
    const safeBlockBody = [
      `vi.mock('${GUARDED_MODULE}', async (importOriginal) => {`,
      `  const actual = await importOriginal<typeof import('${GUARDED_MODULE}')>();`,
      '  return { ...actual, useSyncQuery: () => ({ data: [] }) };',
      '});',
    ].join('\n');

    expect(classifySyncMocks(unsafe)).toEqual(['full-replacement']);
    expect(classifySyncMocks(safe)).toEqual(['spread']);
    expect(classifySyncMocks(safeBlockBody)).toEqual(['spread']);
    expect(classifySyncMocks(asyncButNotSpread)).toEqual(['full-replacement']);
    expect(classifySyncMocks('nothing to see here')).toEqual([]);
  });

  it(`mocks ${GUARDED_MODULE} only by spreading the real module`, () => {
    const offenders = listTestSources(sourceRoot).flatMap((absolute) => {
      const forms = classifySyncMocks(readFileSync(absolute, 'utf8'));
      return forms.includes('full-replacement')
        ? [path.relative(sourceRoot, absolute).split(path.sep).join('/')]
        : [];
    });

    expect(
      offenders,
      `These files replace ${GUARDED_MODULE} wholesale, so the next export a subject imports strands them `
        + 'with an error naming the mock rather than the change. Spread the original instead: '
        + `vi.mock('${GUARDED_MODULE}', async (importOriginal) => ({ ...(await importOriginal<typeof import('${GUARDED_MODULE}')>()), /* overrides */ }))`,
    ).toEqual([]);
  });

  it('actually scanned the mockers it claims are clean (an empty scan is not a pass)', () => {
    // Without this, deleting every mock — or breaking the file walk — would
    // make the guard above pass vacuously. It asserts the scan found real
    // subjects, not that any particular count is correct.
    const mocked = listTestSources(sourceRoot).filter(
      (absolute) => classifySyncMocks(readFileSync(absolute, 'utf8')).length > 0,
    );
    expect(mocked.length).toBeGreaterThan(0);
  });
});
