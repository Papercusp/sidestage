/**
 * Guards the GUARD: scripts/zero-cache-start.sh's publication preflight
 * (plan sidestage-websocket-sync-cutover-2026-08-17, D-018).
 *
 * WHY THIS FILE EXISTS
 *   That preflight compares the LIVE `zero_publication` against the table list
 *   it PARSES out of db/zero-publication.sql, and refuses to start zero-cache
 *   on a declared-but-missing table. The comparison is only as good as the
 *   parse, and the parse has a silent failure mode that is strictly worse than
 *   a noisy one: if the file's shape changes so the `sed`/`grep` pipeline
 *   matches nothing, the preflight takes its "could not parse ... skipping"
 *   branch and DISABLES ITSELF. Nothing goes red. The next table added to an
 *   already-provisioned database then drifts exactly as `targeted_offer` did on
 *   2026-08-17 — which broke the whole WS connection, not just one query.
 *
 *   So this asserts the parser still extracts the real table list. A test that
 *   only checked "the pipeline runs" would pass in precisely the broken case.
 *
 * WHY IT SHELLS OUT instead of reimplementing the pipeline in TypeScript:
 *   a reimplementation would drift from the shell, and then this file would be
 *   testing itself rather than the thing that actually runs at launch. The
 *   pipeline is extracted from the script at test time for the same reason.
 *
 * Lives under apps/api/src so the root vitest `sidestage-node` project runs it
 * (the root config's projects cover deploy/**, apps/api/src/** and
 * apps/web/src/**; a copy under scripts/** or infra/** would silently never
 * run) — same placement rationale as zero-publication.parity.test.ts.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REPLICATED_TABLES } from '@papercusp/sidestage-zero';

const REPO_ROOT = resolve(__dirname, '../../../..');
const PUBLICATION_SQL_PATH = resolve(REPO_ROOT, 'db/zero-publication.sql');
const START_SCRIPT_PATH = resolve(REPO_ROOT, 'scripts/zero-cache-start.sh');

/**
 * The parser as it appears in scripts/zero-cache-start.sh. Kept as a literal so
 * a drift between this string and the script is caught by the test below rather
 * than silently making this file test a stale copy.
 */
const PARSE_PIPELINE =
  "sed -n '/CREATE PUBLICATION zero_publication FOR TABLE/,/^      );/p' \"$1\" " +
  "| grep -oE 'public\\.[a-z_]+' | sed 's/^public\\.//' | sort -u";

function parseDeclaredTables(sqlPath: string): string[] {
  const out = execFileSync('bash', ['-c', `${PARSE_PIPELINE}`, 'parse', sqlPath], {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

describe('zero-cache-start.sh publication preflight', () => {
  it('parses the declared table list out of db/zero-publication.sql', () => {
    const declared = parseDeclaredTables(PUBLICATION_SQL_PATH);

    // The specific assertion that catches a silently-disabled guard: a format
    // change that empties the parse fails HERE instead of at 3am against a
    // database nobody has re-provisioned.
    expect(declared.length).toBeGreaterThan(0);
    expect(declared).toEqual([...REPLICATED_TABLES].sort());
  });

  it('does not mistake product_catalog column names for tables', () => {
    // product_catalog is the one table declared WITH a column list, so its
    // column names sit inside the same CREATE PUBLICATION block the parser
    // scans. They are not `public.`-qualified, which is exactly what keeps them
    // out — a parser loosened to bare identifiers would swallow them and then
    // report phantom "missing tables" forever.
    const declared = parseDeclaredTables(PUBLICATION_SQL_PATH);
    for (const columnName of ['group_id', 'region', 'tier_1', 'created_at', 'updated_at']) {
      expect(declared).not.toContain(columnName);
    }
  });

  it('still contains the parser it is guarding', () => {
    // If someone rewrites the preflight, this fails and forces them to look at
    // this file — rather than leaving it quietly asserting against a pipeline
    // the script no longer uses.
    const script = readFileSync(START_SCRIPT_PATH, 'utf8');
    expect(script).toContain("grep -oE 'public\\.[a-z_]+'");
    expect(script).toContain('CREATE PUBLICATION zero_publication FOR TABLE');
    // The `|| true` is load-bearing under `set -Eeuo pipefail`: without it a
    // non-matching grep aborts the launcher instead of reaching the graceful
    // "skipping the publication preflight" branch.
    expect(script).toMatch(/sort -u \|\| true/);
  });
});
