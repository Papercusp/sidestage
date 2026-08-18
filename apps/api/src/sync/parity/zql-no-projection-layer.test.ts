/**
 * Guard for the premise plan Decision D-024 rests on
 * (sidestage-websocket-sync-cutover-2026-08-17), and through it D-025/D-026/D-027.
 *
 * ## What is being guarded, and why a decision needs a test at all
 *
 * D-024 rules that **a Zero row's shape IS the replicated table's shape** — a
 * ZQL leaf can filter, order, limit and join, but it cannot rename a field,
 * compute one, unpack a jsonb column, or re-encode a value. Everything built on
 * that follows from it: the lineup rename moves to the REST DTO rather than the
 * leaf (D-024), payload-jsonb document stores are demoted instead of "fixed"
 * (D-025), timestamps are coerced REST-side because Zero's mapping cannot be
 * re-encoded (D-026), and column exposure is settled at the publication because
 * the leaf cannot withhold (D-027).
 *
 * That premise is a fact about a THIRD-PARTY LIBRARY, and `@rocicorp/zero` is
 * pinned as a CARET range (`^1.8.0`, apps/web/package.json + libs/zero/package.json).
 * A minor bump can therefore add a projection API with no change on our side and
 * silently invalidate four governing decisions — the exact rot su-bb5ea5f0 named
 * in the D-024 critique consult, and the reason D-028 rules that this premise
 * gets a GUARD rather than a version pin. A pin freezes the library; a guard
 * lets it move and tells us when the move matters.
 *
 * ## Why this reads the .d.ts rather than probing a query object
 *
 * The claim is about the API SURFACE Zero offers, not about what one builder
 * instance happens to expose at runtime — a runtime probe would need a live
 * schema and a connection, and would still only see the methods that survived
 * whatever wrapper produced the object. The declaration file IS the surface.
 *
 * ## The positive control is load-bearing, not decoration
 *
 * This test's core assertion is an ABSENCE ("no projection method"), and an
 * absence measured with a broken instrument is indistinguishable from a real
 * one: if the path moves in a future Zero, the extraction silently yields an
 * EMPTY method set and every "is absent" assertion passes vacuously — reporting
 * the premise as confirmed at exactly the moment it stopped being measured.
 * So the control asserts the methods we KNOW are there. If it fails, the
 * instrument is broken and the test fails loudly instead of going green.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const require_ = createRequire(import.meta.url);

/** Methods that would give a leaf the ability to reshape a row. Their ABSENCE is D-024. */
const PROJECTION_METHODS = ['select', 'project', 'pick', 'omit', 'map', 'transform'] as const;

/**
 * Methods Zero certainly has. These are the positive control: they prove the
 * extraction actually read a method set, so an empty `PROJECTION_METHODS`
 * intersection means "absent" rather than "never looked".
 */
const KNOWN_PRESENT = ['where', 'orderBy', 'limit', 'related', 'one'] as const;

/**
 * Locate the installed package root.
 *
 * NOT via `require.resolve('@rocicorp/zero/package.json')`: Zero ships an
 * `exports` map that does not expose `./package.json`, so that throws
 * `Package subpath './package.json' is not defined by "exports"`. Resolve the
 * public entry point instead and walk up to the `@rocicorp/zero` directory —
 * which also keeps this working from either checkout, since the suite runs from
 * the hive (~/.papercusp/hives/sidestage) rather than the workspace tree.
 */
function resolvePackageRoot(): string {
  let dir = dirname(require_.resolve('@rocicorp/zero'));
  for (let hop = 0; hop < 12; hop += 1) {
    if (basename(dir) === 'zero' && basename(dirname(dir)) === '@rocicorp') return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not walk up to the @rocicorp/zero package root from ` +
      `${require_.resolve('@rocicorp/zero')}. This is an INSTRUMENT failure, ` +
      `not a pass — the D-024 premise is now UNMEASURED.`,
  );
}

function resolveQueryDeclaration(): string {
  const root = resolvePackageRoot();
  const candidates = [
    join(root, 'out/zql/src/query/query.d.ts'),
    join(root, 'out/zero-client/src/query/query.d.ts'),
    join(root, 'out/zql/query/query.d.ts'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `Could not locate Zero's Query declaration under ${root}. Tried:\n` +
        candidates.map((c) => `  - ${c}`).join('\n') +
        `\n\nThis is an INSTRUMENT failure, not a pass: the D-024 premise ` +
        `(a ZQL leaf cannot project) is now UNMEASURED. Find the moved ` +
        `declaration and add its path above before trusting any parity ruling.`,
    );
  }
  return found;
}

/** Method names declared on the `Query` interface, in declaration order. */
function declaredQueryMethods(): string[] {
  const source = readFileSync(resolveQueryDeclaration(), 'utf8');
  const names = new Set<string>();
  // Interface members are indented 2-4 spaces and are followed by a type
  // parameter list, a call signature, or an optional marker.
  for (const match of source.matchAll(/^\s{2,4}([a-zA-Z][a-zA-Z0-9_]*)[<(?]/gm)) {
    names.add(match[1]);
  }
  return [...names];
}

describe('D-024 premise: ZQL has no projection layer', () => {
  it('exposes the methods we rely on (POSITIVE CONTROL — proves the extraction works)', () => {
    const methods = declaredQueryMethods();
    // Fail loudly on an empty read rather than letting the absence assertions
    // below pass vacuously against nothing.
    expect(methods.length).toBeGreaterThan(5);
    for (const known of KNOWN_PRESENT) {
      expect(methods, `expected Zero's Query surface to declare '${known}'`).toContain(known);
    }
  });

  it('declares NO method that could reshape a row', () => {
    const methods = declaredQueryMethods();
    const found = PROJECTION_METHODS.filter((method) => methods.includes(method));
    expect(
      found,
      found.length === 0
        ? ''
        : `Zero's Query surface now declares ${found.join(', ')} — a PROJECTION seam.\n\n` +
          `This does not mean this test is wrong; it means plan Decisions D-024, D-025, D-026 ` +
          `and D-027 (sidestage-websocket-sync-cutover-2026-08-17) rest on a premise that just ` +
          `stopped holding, and each must be revisited before the WS rung is promoted:\n` +
          `  - D-024: the lineup rename may belong in the leaf after all, not the REST DTO.\n` +
          `  - D-025: the payload-jsonb demotions may be reversible if a leaf can unpack jsonb.\n` +
          `  - D-026: timestamps may be coercible leaf-side rather than REST-side.\n` +
          `  - D-027: a leaf may be able to withhold a column without a publication change.\n` +
          `Do NOT simply add the new method to PROJECTION_METHODS' allowed set to go green.`,
    ).toEqual([]);
  });
});
