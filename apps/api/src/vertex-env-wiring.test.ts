import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Vertex configuration lives on three surfaces that drift independently: the
 * SOURCE that reads an env var, the production API CONTAINER that has to
 * forward it, and `.env.example` — the only place an operator learns the var
 * exists at all.
 *
 * The pre-existing guard (scout.module.test.ts, "forwards optional Vertex
 * configuration into the production API container") hand-listed three of the
 * seven Vertex/Google keys the api service actually declares. Deleting any of
 * the other four from docker-compose.prod.yml left every suite green. That is
 * the same hand-listed-subset defect this plan already paid for once in P-001,
 * where a regex anchored on ONE selector of a shared list stayed green after a
 * sibling was removed.
 *
 * So this test DERIVES all three sets and asserts containment between them:
 *   source-read  ⊆ compose api env   (a var the code reads must be forwarded)
 *   compose Vertex env ⊆ .env.example (a var prod forwards must be documented)
 * A key added to any surface is then measured rather than remembered.
 *
 * The calibration block is load-bearing, not ceremony: every assertion below is
 * a containment check, and containment against an EMPTY derived set passes
 * vacuously. Calibration is what separates "nothing is missing" from "the
 * extractor matched nothing" — the failure mode that makes a broken guard look
 * like a clean bill of health.
 *
 * Subject paths are overridable so falsifiability can be proven against a COPY
 * (scripts/mutation-probe.sh tier 2) instead of mutating this shared checkout.
 */

const REPO_ROOT = resolve(__dirname, '../../..');

const COMPOSE_PATH =
  process.env.SIDESTAGE_VERTEX_GUARD_COMPOSE
  ?? resolve(REPO_ROOT, 'docker-compose.prod.yml');

const ENV_EXAMPLE_PATH =
  process.env.SIDESTAGE_VERTEX_GUARD_ENV_EXAMPLE
  ?? resolve(REPO_ROOT, '.env.example');

const SOURCE_ROOTS = (
  process.env.SIDESTAGE_VERTEX_GUARD_SOURCE_ROOTS
  ?? 'apps/api/src,libs/scout-runtime/src'
)
  .split(',')
  .map((relative) => resolve(REPO_ROOT, relative.trim()));

/** GOOGLE_* is the Vertex/ADC family; *VERTEX* covers the per-surface models. */
const VERTEX_KEY = /^(GOOGLE_[A-Z0-9_]+|[A-Z0-9_]*VERTEX[A-Z0-9_]*)$/;

const isVertexKey = (key: string) => VERTEX_KEY.test(key);

/**
 * build-history.snapshot.ts is a serialized archive of past plan markdown that
 * quotes these very variable names. It is excluded so the derivation measures
 * code that READS an env var, not prose that mentions one.
 */
const SKIP_FILE = /(\.test\.ts|\.spec\.ts|build-history\.snapshot\.ts)$/;
const SKIP_DIR = /^(node_modules|dist|build|coverage|\.next)$/;

function typescriptFilesUnder(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIR.test(entry.name)) walk(full);
      } else if (entry.name.endsWith('.ts') && !SKIP_FILE.test(entry.name)) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

/** Matches both `process.env.FOO` and a destructured/aliased `env.FOO`. */
function vertexKeysReadBySource(roots: string[]): Set<string> {
  const keys = new Set<string>();
  for (const root of roots) {
    for (const file of typescriptFilesUnder(root)) {
      const source = readFileSync(file, 'utf8');
      for (const [, key] of source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) {
        if (isVertexKey(key)) keys.add(key);
      }
      for (const [, key] of source.matchAll(
        /\benv\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
      )) {
        if (isVertexKey(key)) keys.add(key);
      }
    }
  }
  return keys;
}

/**
 * The api service block runs until the next 2-space-indented service key.
 * Environment entries are the 6-space-indented SCREAMING_CASE names inside it.
 */
function apiServiceEnvKeys(compose: string): Set<string> {
  const block = compose.match(/\n {2}api:\n([\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|$)/)?.[1] ?? '';
  return new Set(
    [...block.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map(([, key]) => key),
  );
}

function documentedKeys(envExample: string): Set<string> {
  return new Set(
    [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(([, key]) => key),
  );
}

const sourceKeys = vertexKeysReadBySource(SOURCE_ROOTS);
const composeKeys = apiServiceEnvKeys(readFileSync(COMPOSE_PATH, 'utf8'));
const documented = documentedKeys(readFileSync(ENV_EXAMPLE_PATH, 'utf8'));
const composeVertexKeys = [...composeKeys].filter(isVertexKey).sort();

const sorted = (keys: Iterable<string>) => [...keys].sort();

describe('Vertex environment wiring', () => {
  /**
   * CALIBRATION. Each extractor is asserted to have found an anchor that is
   * known to exist and that no assertion below depends on, so a silently
   * broken extractor fails HERE — loudly — instead of turning every
   * containment check into a vacuous pass.
   */
  it('CALIBRATION: all three derivations actually found their surface', () => {
    expect(
      sorted(sourceKeys),
      'source scan found no Vertex env reads — the walk or regex is broken',
    ).toEqual(expect.arrayContaining(['GOOGLE_CLOUD_PROJECT', 'SCOUT_VERTEX_MODEL']));

    // A non-Vertex anchor: proves the api service block was located and parsed,
    // independently of anything the Vertex assertions look at.
    expect(
      sorted(composeKeys),
      'api service block not located in docker-compose.prod.yml',
    ).toEqual(expect.arrayContaining(['DEEPGRAM_API_KEY', 'DATABASE_URL']));

    expect(
      sorted(documented),
      '.env.example parsed to no keys — the extractor is broken',
    ).toEqual(expect.arrayContaining(['DATABASE_URL']));

    expect(composeVertexKeys.length).toBeGreaterThan(0);
  });

  it('forwards every Vertex variable the API source reads into the production container', () => {
    const unwired = sorted(sourceKeys).filter((key) => !composeKeys.has(key));

    expect(
      unwired,
      'read by apps/api but never forwarded to the api service in '
        + 'docker-compose.prod.yml, so production silently runs the '
        + 'deterministic engine',
    ).toEqual([]);
  });

  it('documents every Vertex variable the production container forwards', () => {
    const undocumented = composeVertexKeys.filter((key) => !documented.has(key));

    expect(
      undocumented,
      'forwarded by docker-compose.prod.yml but absent from .env.example, so an '
        + 'operator has no way to learn the variable exists',
    ).toEqual([]);
  });
});
