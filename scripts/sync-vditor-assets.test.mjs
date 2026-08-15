/**
 * Recurrence guard for WI-39341.
 *
 * The bug was not "assets were missing" — they were on disk the whole time.
 * It was that `apps/web/public/vditor` had been DELETED and recreated while a
 * Vite dev server was watching it, so chokidar's subtree watch was dropped and
 * every asset under it silently became a 404 (served as the SPA index.html
 * fallback). Vditor could not load Lute and the History tab's plan popup fell
 * back to raw text.
 *
 * So the property under test is directory IDENTITY, asserted by inode: a sync
 * must never replace a directory that a watcher may be holding. Asserting only
 * "the files are present afterwards" would pass against the original
 * rm-then-copy implementation, which is exactly the bug — the files were
 * present then too.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SENTINEL_ASSET, STAMP_FILE, mirrorIsCurrent, syncVditorAssets } from './sync-vditor-assets.mjs';

let root;

/** A miniature vditor install: the sentinel Lute asset plus a couple of siblings. */
function installVditor(version, extraFiles = {}) {
  const dist = join(root, 'node_modules/vditor/dist');
  mkdirSync(join(dist, 'js/lute'), { recursive: true });
  writeFileSync(join(root, 'node_modules/vditor/package.json'), JSON.stringify({ version }));
  writeFileSync(join(dist, SENTINEL_ASSET.replace('dist/', '')), `lute-${version}`);
  writeFileSync(join(dist, 'index.css'), `css-${version}`);
  for (const [relativePath, contents] of Object.entries(extraFiles)) {
    mkdirSync(join(dist, relativePath, '..'), { recursive: true });
    writeFileSync(join(dist, relativePath), contents);
  }
}

const mirrorRoot = () => join(root, 'apps/web/public/vditor');
const inode = (path) => statSync(path).ino;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sidestage-vditor-'));
  mkdirSync(join(root, 'apps/web/public'), { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Vditor asset mirror', () => {
  it('populates the mirror and stamps the installed version on a cold sync', () => {
    installVditor('3.11.2');

    const result = syncVditorAssets({ root });

    expect(result.changed).toBe(true);
    expect(result.version).toBe('3.11.2');
    expect(readFileSync(join(mirrorRoot(), SENTINEL_ASSET), 'utf8')).toBe('lute-3.11.2');
    expect(JSON.parse(readFileSync(join(mirrorRoot(), STAMP_FILE), 'utf8')).version).toBe('3.11.2');
  });

  it('never replaces a watched directory when the mirror must be refreshed', () => {
    installVditor('3.11.2');
    syncVditorAssets({ root });

    // Identity of every directory a dev-server watch could be holding.
    const before = {
      mirror: inode(mirrorRoot()),
      dist: inode(join(mirrorRoot(), 'dist')),
      lute: inode(join(mirrorRoot(), 'dist/js/lute')),
    };

    installVditor('3.12.0');
    const result = syncVditorAssets({ root });

    expect(result.changed).toBe(true);
    expect(readFileSync(join(mirrorRoot(), SENTINEL_ASSET), 'utf8')).toBe('lute-3.12.0');
    // A recreated directory gets a new inode, which is precisely what drops a
    // chokidar watch and turns every asset underneath into a 404.
    expect(inode(mirrorRoot())).toBe(before.mirror);
    expect(inode(join(mirrorRoot(), 'dist'))).toBe(before.dist);
    expect(inode(join(mirrorRoot(), 'dist/js/lute'))).toBe(before.lute);
  });

  it('mutates nothing when the mirror already matches the installed version', () => {
    installVditor('3.11.2');
    syncVditorAssets({ root });
    const stampBefore = readFileSync(join(mirrorRoot(), STAMP_FILE), 'utf8');
    const luteMtimeBefore = statSync(join(mirrorRoot(), SENTINEL_ASSET)).mtimeMs;

    const result = syncVditorAssets({ root });

    expect(result.changed).toBe(false);
    // An unchanged stamp AND an unchanged mtime together prove no rewrite
    // happened — a re-copy would refresh the mtime even with identical bytes.
    expect(readFileSync(join(mirrorRoot(), STAMP_FILE), 'utf8')).toBe(stampBefore);
    expect(statSync(join(mirrorRoot(), SENTINEL_ASSET)).mtimeMs).toBe(luteMtimeBefore);
  });

  it('re-syncs when the stamp is current but the asset Vditor needs is gone', () => {
    installVditor('3.11.2');
    syncVditorAssets({ root });
    rmSync(join(mirrorRoot(), SENTINEL_ASSET));

    expect(mirrorIsCurrent(mirrorRoot(), '3.11.2')).toBe(false);
    expect(syncVditorAssets({ root }).changed).toBe(true);
    expect(existsSync(join(mirrorRoot(), SENTINEL_ASSET))).toBe(true);
  });

  it('prunes assets dropped by a Vditor upgrade without disturbing surviving directories', () => {
    installVditor('3.11.2', { 'js/legacy/old-plugin.js': 'retired' });
    syncVditorAssets({ root });
    expect(existsSync(join(mirrorRoot(), 'dist/js/legacy/old-plugin.js'))).toBe(true);
    const jsInodeBefore = inode(join(mirrorRoot(), 'dist/js'));

    rmSync(join(root, 'node_modules/vditor'), { recursive: true, force: true });
    installVditor('3.12.0');
    const result = syncVditorAssets({ root });

    expect(result.pruned).toContain(join('js', 'legacy', 'old-plugin.js'));
    expect(existsSync(join(mirrorRoot(), 'dist/js/legacy'))).toBe(false);
    // `js` survives the upgrade, so pruning must leave its identity alone.
    expect(inode(join(mirrorRoot(), 'dist/js'))).toBe(jsInodeBefore);
  });

  it('fails loudly when Vditor is not installed rather than emptying the mirror', () => {
    installVditor('3.11.2');
    syncVditorAssets({ root });
    rmSync(join(root, 'node_modules/vditor/dist'), { recursive: true, force: true });

    expect(() => syncVditorAssets({ root })).toThrow(/run npm install first/);
    expect(existsSync(join(mirrorRoot(), SENTINEL_ASSET))).toBe(true);
  });
});
