import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * WI-2146323: every `vitest run` and `vite build` in a sidestage-owned script
 * sets its own NODE_ENV instead of inheriting one.
 *
 * `npm run green` is `npm run build && npm test`. The release runners that call it
 * hand it two different inherited NODE_ENV values, and either one breaks half
 * of the command:
 *
 *  - NODE_ENV=production (the operator's own env, inherited by the gate):
 *    vite's resolver returns the bare id `__vite-browser-external` for a
 *    browser-externalized builtin, vitest's toBuiltin turns that into `node:`, and
 *    every jsdom test file dies at environment load with
 *    "No such built-in module: node:".
 *  - NODE_ENV=test (forced by the admission precheck): `vite build` emits the
 *    development React bundle. The public entry measured 601,322 bytes against
 *    the 380,000-byte budget, versus 339,817 bytes for a production build.
 *
 * Vitest and Vite pick the right value only when NODE_ENV is unset, so each
 * leaf command pins it explicitly.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNED_MANIFESTS = ['package.json', 'apps/web/package.json', 'apps/api/package.json'];

/** Split a script into its shell command segments (`&&`, `||`, `;`). */
export function commandSegments(script) {
  return script.split(/&&|\|\||;/).map((segment) => segment.trim()).filter(Boolean);
}

/** NODE_ENV each tool must run under, keyed by the tool invocation it guards. */
const REQUIRED_ENV = [
  { tool: /(^|\s)vitest\s+run(\s|$)/, env: 'test' },
  { tool: /(^|\s)vite\s+build(\s|$)/, env: 'production' },
];

export function nodeEnvViolations(scripts) {
  const violations = [];
  for (const [name, script] of Object.entries(scripts)) {
    for (const segment of commandSegments(script)) {
      for (const { tool, env } of REQUIRED_ENV) {
        if (!tool.test(segment)) continue;
        if (!segment.startsWith(`NODE_ENV=${env} `)) {
          violations.push(`${name}: "${segment}" must start with NODE_ENV=${env}`);
        }
      }
    }
  }
  return violations;
}

describe('NODE_ENV pinning in sidestage-owned scripts', () => {
  for (const manifest of OWNED_MANIFESTS) {
    it(`${manifest}: every vitest run / vite build pins NODE_ENV`, () => {
      const { scripts = {} } = JSON.parse(readFileSync(join(root, manifest), 'utf8'));
      expect(nodeEnvViolations(scripts)).toEqual([]);
    });
  }

  it('rejects an unpinned or wrongly pinned leaf command', () => {
    expect(nodeEnvViolations({
      build: 'tsc --noEmit && vite build',
      test: 'vitest run --project x',
      wrong: 'NODE_ENV=production vitest run',
    })).toEqual([
      'build: "vite build" must start with NODE_ENV=production',
      'test: "vitest run --project x" must start with NODE_ENV=test',
      'wrong: "NODE_ENV=production vitest run" must start with NODE_ENV=test',
    ]);
  });

  it('ignores scripts that run neither tool', () => {
    expect(nodeEnvViolations({ typecheck: 'tsc --noEmit', dev: 'vite' })).toEqual([]);
  });
});
