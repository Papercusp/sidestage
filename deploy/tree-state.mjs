#!/usr/bin/env node
/**
 * Composed-tree fingerprint, recursive through every submodule.
 *
 * WHY THIS EXISTS (EI-20493745845506415). Release verification here used to be
 * done by hand: capture `git rev-parse HEAD` + `git status --porcelain` +
 * `git diff` before a suite, capture it again afterwards, and call the tree
 * unchanged when the two digests match. That check CANNOT see inside a
 * submodule, because the superproject's entire record of one is a gitlink plus
 * a one-bit `-dirty` suffix:
 *
 *     -Subproject commit e2f335f7…
 *     +Subproject commit e2f335f7…-dirty
 *
 * So the clean -> dirty transition is caught, and then nothing else ever is.
 * Once a submodule is dirty, editing a tracked file inside it and dropping a
 * brand-new untracked file inside it produce the SAME superproject digest as
 * each other and as the merely-dirty state. On 2026-08-15 a full `npm run
 * check` "passed" with an identical before/after fingerprint while the tree
 * held `m libs/scout-runtime` throughout — dirty before AND after, which is
 * precisely the blind case, so the matching digests proved nothing.
 *
 * That is not a cosmetic gap. deploy/deploy.sh ships the output of
 * deploy/snapshot-source.sh, which recurses submodules with `read-tree HEAD`
 * followed by `add -A` — the deploy payload is submodule WORKING-TREE content.
 * Content the old check could not see is content that ships.
 *
 * WHAT THIS MEASURES. For the superproject and for every recursive submodule:
 * its path, its HEAD, its porcelain status, and a `write-tree` sha taken over
 * a TEMPORARY index seeded from HEAD and then `add -A`'d. That last one is the
 * load-bearing field: it is a content hash of the repository's full working
 * tree — tracked modifications, binary contents and untracked files alike —
 * built the same way, with the same excludes, that snapshot-source.sh builds
 * the payload. The digest therefore tracks the bytes a deploy would actually
 * ship rather than git's summary of them.
 *
 * The temporary index is addressed through GIT_INDEX_FILE, so the repository's
 * real index and working tree are never touched (the same technique, for the
 * same reason, as snapshot-source.sh).
 *
 * CONSERVATIVE BY CHOICE. Porcelain status is part of the digest even though
 * the tree sha already covers final content. Two states with identical content
 * but different staging therefore report as different. For a release verifier
 * a false alarm costs one re-read, while a false pass ships unreviewed code —
 * so the tie is broken toward alarming.
 *
 * USAGE
 *   node deploy/tree-state.mjs                 # print the digest
 *   node deploy/tree-state.mjs --json          # per-repository detail
 *   node deploy/tree-state.mjs --repo <path>   # default: enclosing repo root
 *
 * Capture it before and after the work, and compare:
 *   before="$(node deploy/tree-state.mjs)"
 *   npm run check
 *   [ "$before" = "$(node deploy/tree-state.mjs)" ] || echo 'TREE MOVED'
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Kept byte-identical in spirit to snapshot-source.sh's exclude list: the
 * fingerprint must measure what the snapshot ships, so the two must agree on
 * what is not source. Test-run state is never application source, and some
 * shared libraries committed Vitest cache entries before the convention
 * existed.
 */
const EXCLUDE_FILE_BODY = '.vitest-tmp/\n';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function runGit(repository, args, { indexFile, excludesFile } = {}) {
  const environment = { ...process.env };
  if (indexFile) {
    environment.GIT_INDEX_FILE = indexFile;
  } else {
    // A caller's ambient GIT_INDEX_FILE would silently redirect the reads that
    // are supposed to see the repository's REAL index.
    delete environment.GIT_INDEX_FILE;
  }

  const prefix = excludesFile ? ['-c', `core.excludesFile=${excludesFile}`] : [];
  return execFileSync('git', [...prefix, '-C', repository, ...args], {
    encoding: 'utf8',
    env: environment,
    maxBuffer: MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * The full working-tree content of ONE repository as a single tree sha, via a
 * throwaway index. Seeded from HEAD then `add -A` so the result covers tracked
 * edits and untracked files; the repository's own index and worktree are left
 * exactly as they were.
 */
function workingTreeSha(repository, scratchDirectory, ordinal) {
  const indexFile = path.join(scratchDirectory, `index-${ordinal}`);
  const excludesFile = path.join(scratchDirectory, 'excludes');
  const options = { indexFile, excludesFile };

  runGit(repository, ['read-tree', 'HEAD'], options);
  runGit(repository, ['add', '-A', '--', '.'], options);
  runGit(
    repository,
    ['rm', '-r', '-f', '--cached', '--ignore-unmatch', '--', '.vitest-tmp', ':(glob)**/.vitest-tmp/**'],
    options,
  );

  const tree = runGit(repository, ['write-tree'], options).trim();
  const staged = runGit(repository, ['ls-files', '--stage', '-z'], options);
  return { tree, staged };
}

function headOf(repository) {
  try {
    return runGit(repository, ['rev-parse', 'HEAD']).trim();
  } catch {
    // An unborn HEAD is a legitimate state, and reporting it beats throwing:
    // the whole point is that nothing about the tree goes unrecorded.
    return 'UNBORN';
  }
}

function porcelainOf(repository) {
  // --untracked-files=all so a directory of new files is not collapsed to a
  // single entry; the digest should move when any one of them appears.
  return runGit(repository, ['status', '--porcelain', '--untracked-files=all']);
}

/**
 * Is `candidate` a POPULATED repository in its own right?
 *
 * The obvious test — `rev-parse --is-inside-work-tree` — is wrong here, and
 * wrong in the direction that matters. A de-initialized submodule leaves an
 * empty directory behind, and git answers `true` for it: the directory really
 * is inside a work tree, just the PARENT's. Recursing on that answer runs
 * `read-tree HEAD` against the parent's HEAD and then dies on `add -A` with
 * "fatal: in unpopulated submodule". Comparing toplevels asks the question
 * actually intended: does this path own a repository, or is it a hole where one
 * used to be?
 */
function isPopulatedRepository(candidate) {
  try {
    const toplevel = runGit(candidate, ['rev-parse', '--show-toplevel']).trim();
    return realpathSync(toplevel) === realpathSync(candidate);
  } catch {
    return false;
  }
}

/** Gitlink entries (mode 160000) from the throwaway index, in path order. */
function submodulePaths(stagedEntries) {
  const paths = [];
  for (const entry of stagedEntries.split('\0')) {
    if (!entry) continue;
    const tabIndex = entry.indexOf('\t');
    if (tabIndex === -1) continue;
    const mode = entry.slice(0, entry.indexOf(' '));
    if (mode !== '160000') continue;
    paths.push(entry.slice(tabIndex + 1));
  }
  return paths.sort();
}

/**
 * @returns {{ digest: string, repositories: Array<object> }}
 */
export function computeTreeState(repositoryArgument) {
  const repositoryRoot = runGit(repositoryArgument, ['rev-parse', '--show-toplevel']).trim();
  const scratchDirectory = mkdtempSync(path.join(tmpdir(), 'sidestage-tree-state.'));
  writeFileSync(path.join(scratchDirectory, 'excludes'), EXCLUDE_FILE_BODY);

  const repositories = [];
  let ordinal = 0;

  const visit = (repository, relativePath) => {
    ordinal += 1;
    const { tree, staged } = workingTreeSha(repository, scratchDirectory, ordinal);
    const porcelain = porcelainOf(repository);

    repositories.push({
      path: relativePath,
      head: headOf(repository),
      tree,
      porcelainSha: sha256(porcelain),
      porcelain,
    });

    for (const submodulePath of submodulePaths(staged)) {
      const absolute = path.join(repository, submodulePath);
      const nested = relativePath === '.' ? submodulePath : `${relativePath}/${submodulePath}`;
      if (!isPopulatedRepository(absolute)) {
        // An uninitialized submodule is RECORDED, never skipped silently: "no
        // content here" is itself a state whose change must move the digest.
        repositories.push({
          path: nested,
          head: 'UNINITIALIZED',
          tree: 'UNINITIALIZED',
          porcelainSha: sha256(''),
          porcelain: '',
        });
        continue;
      }
      visit(absolute, nested);
    }
  };

  try {
    visit(repositoryRoot, '.');
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }

  const canonical = repositories
    .map((entry) => `${entry.path}\t${entry.head}\t${entry.tree}\t${entry.porcelainSha}`)
    .join('\n');

  return { digest: sha256(canonical), repositories };
}

function main(argv) {
  let repositoryArgument = process.cwd();
  let asJson = false;

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--json') {
      asJson = true;
    } else if (argv[index] === '--repo') {
      repositoryArgument = argv[index + 1];
      index += 1;
      if (!repositoryArgument) {
        process.stderr.write('tree-state: --repo requires a path\n');
        return 2;
      }
    } else {
      process.stderr.write(`tree-state: unknown argument: ${argv[index]}\n`);
      return 2;
    }
  }

  const state = computeTreeState(repositoryArgument);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  } else {
    process.stdout.write(`${state.digest}\n`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
