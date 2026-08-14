#!/usr/bin/env node
/**
 * preflight-manifest.mjs — catch the "ships an importer without its module" class
 * BEFORE rsync, instead of 5 minutes later as an opaque remote docker failure.
 *
 * WHY THIS EXISTS (EI-20405847964610211)
 * deploy.sh builds its rsync manifest from the git-TRACKED set (`git ls-files` +
 * `git submodule foreach git ls-files`) but rsync then sends each listed path's
 * WORKING-TREE CONTENT. Manifest is HEAD-shaped; content is working-tree-shaped.
 * Those are different snapshots, and the gap is a live production trap:
 *
 *   apps/api/src/db/database.module.ts  TRACKED   -> shipped, imports './schema-guard'
 *   apps/api/src/db/schema-guard.ts     UNTRACKED -> NOT shipped
 *   => prod `tsc -p tsconfig.json`: TS2307 Cannot find module './schema-guard'
 *
 * Locally everything is green, because locally the file is simply on disk. The
 * local suite and typecheck CANNOT see this class by construction — only a check
 * against the MANIFEST can.
 *
 * It also catches the second form: git-sync's content guard can deliberately
 * EXCLUDE a file from a commit (parse error, quarantined importer), which
 * protects HEAD but NOT this deploy, because the deploy never reads HEAD.
 *
 * Exit 0 = every relative import among shipped files resolves inside the manifest.
 * Exit 1 = at least one dangling import; each is printed with its importer.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

const git = (args, cwd = root) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The EXACT manifest deploy.sh ships — keep these two in lockstep. */
function manifest() {
  const top = git(['ls-files']).split('\n').filter(Boolean);
  const subs = git([
    'submodule', 'foreach', '--quiet',
    'git ls-files | sed "s|^|$sm_path/|"',
  ]).split('\n').filter(Boolean);
  return new Set([...top, ...subs]);
}

// Only source files can carry a relative import worth resolving.
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
// `import x from './y'`, `export * from './y'`, `import('./y')`, `require('./y')`.
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](\.[^'"]*)['"]/g;
// A specifier may omit its extension, or name a directory with an index file.
const CANDIDATES = ['', '.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs',
  '/index.ts', '/index.tsx', '/index.js', '/index.mjs'];

/**
 * TypeScript ESM (NodeNext) requires source to SPELL the emitted extension: a
 * file written as `import './index.js'` is satisfied by `index.ts` on disk and
 * NEVER by an `index.js`. Resolving the literal spelling alone reports every
 * such import as dangling — 35 false positives on the first run of this script,
 * which would have made the guard pure noise. Map the emitted extension back to
 * its source forms and try those too.
 */
const JS_TO_TS = { '.js': ['.ts', '.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'] };
function resolvesInManifest(target, shipped) {
  if (CANDIDATES.some((ext) => shipped.has(target + ext))) return true;
  for (const [emitted, sources] of Object.entries(JS_TO_TS)) {
    if (!target.endsWith(emitted)) continue;
    const stem = target.slice(0, -emitted.length);
    if (sources.some((ext) => shipped.has(stem + ext))) return true;
  }
  return false;
}
function existsAnyForm(target, root) {
  if (CANDIDATES.some((ext) => existsSync(path.join(root, target + ext)))) return true;
  for (const [emitted, sources] of Object.entries(JS_TO_TS)) {
    if (!target.endsWith(emitted)) continue;
    const stem = target.slice(0, -emitted.length);
    if (sources.some((ext) => existsSync(path.join(root, stem + ext)))) return true;
  }
  return false;
}

/**
 * Only what the PRODUCTION images actually compile. The prod Dockerfiles build
 * @papercusp/typesense, sidestage-api and sidestage-web; libs/test-config is a
 * dev-only test harness whose files legitimately reference mock specifiers
 * (`./x`, `./foo`) that never resolve on disk by design. Compiling those is not
 * something prod ever does, so flagging them is a false alarm, not a finding.
 */
const SHIPPED_SCOPE = /^(apps\/(api|web)\/src\/|libs\/(?!test-config\/))/;

const shipped = manifest();
const dangling = [];

for (const file of shipped) {
  if (!SOURCE.test(file)) continue;
  if (!SHIPPED_SCOPE.test(file)) continue;
  const abs = path.join(root, file);
  // A manifest entry can be absent from disk (submodule gitlink, deleted-but-tracked).
  if (!existsSync(abs) || !statSync(abs).isFile()) continue;

  let text;
  try { text = readFileSync(abs, 'utf8'); } catch { continue; }

  const dir = path.posix.dirname(file);
  for (const [, spec] of text.matchAll(SPECIFIER)) {
    const target = path.posix.normalize(path.posix.join(dir, spec));
    // Resolves if ANY candidate extension/index form is itself being shipped.
    if (resolvesInManifest(target, shipped)) continue;
    // Distinguish "missing everywhere" from the real bug: "on disk but NOT shipped".
    dangling.push({ importer: file, spec, target, onDisk: existsAnyForm(target, root) });
  }
}

if (dangling.length === 0) {
  console.log(`preflight-manifest: OK — ${shipped.size} manifest entries, 0 dangling relative imports.`);
  process.exit(0);
}

console.error(`preflight-manifest: ${dangling.length} DANGLING relative import(s) — deploy would fail on prod.\n`);
for (const d of dangling) {
  const why = d.onDisk
    ? 'EXISTS ON DISK BUT IS NOT IN THE MANIFEST (untracked, or excluded by git-sync)'
    : 'does not exist on disk either';
  console.error(`  ${d.importer}`);
  console.error(`    imports '${d.spec}' -> ${d.target}`);
  console.error(`    ${why}\n`);
}
console.error("Fix: get the target committed (git-sync:run), or revert the importer. Do NOT deploy —");
console.error('the prod docker build will fail on it, and the local suite cannot see this class.');
process.exit(1);
