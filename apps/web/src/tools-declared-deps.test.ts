/**
 * EI-21343954787970444 — guard: every bare package a `tools/**` script imports must be
 * DECLARED in a package.json this workspace actually owns (apps/web's own, or the
 * workspace root's). "Resolvable" is not enough: a transitive dependency of a sibling
 * (playwright-core, hoisted into root node_modules) resolves today and vanishes on the
 * next unrelated install — which is exactly how the whole theme-audit browser-QA suite
 * shipped importing 'playwright' with the package declared NOWHERE, so every documented
 * probe invocation died on ERR_MODULE_NOT_FOUND.
 *
 * Mirrors the theme-audit README's two properties:
 *   1. Falsifiable control — the scan must FIND files and must extract 'playwright'
 *      from the probes; an empty/miswired scan fails rather than passing vacuously.
 *   2. Proven before green — violations are reported per file+specifier, so a green
 *      run means "every import checked", never "nothing scanned".
 */
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..'); // apps/web
const repoRoot = path.resolve(webRoot, '..', '..');
const toolsDir = path.join(webRoot, 'tools');

function listScripts(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listScripts(full));
    else if (/\.(mjs|cjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Bare import specifiers (static, re-export, and dynamic) in one source text. */
function bareSpecifiers(source: string): string[] {
  const specs = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g, // import x from '…' / import '…'
    /(?:^|\n)\s*export\s+[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g, // export … from '…'
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('…')
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, // CJS require('…')
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.add(m[1]);
  }
  return [...specs].filter((s) => !s.startsWith('.') && !s.startsWith('/') && !s.startsWith('node:'));
}

/** '@scope/pkg/sub' -> '@scope/pkg'; 'pkg/sub' -> 'pkg'. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function declaredNames(pkgJsonPath: string): Set<string> {
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
}

describe('tools/** scripts only import declared packages (EI-21343954787970444)', () => {
  const files = listScripts(toolsDir);
  const declared = new Set([...declaredNames(path.join(webRoot, 'package.json')), ...declaredNames(path.join(repoRoot, 'package.json'))]);
  const builtins = new Set(builtinModules);

  const perFile = files.map((file) => ({
    file: path.relative(webRoot, file),
    packages: [...new Set(bareSpecifiers(readFileSync(file, 'utf8')).map(packageName))].filter((p) => !builtins.has(p)),
  }));

  it('falsifiable control: the scan finds the probe scripts and extracts their playwright import', () => {
    expect(files.length).toBeGreaterThanOrEqual(8); // the theme-audit suite alone has 8+ scripts
    const allPackages = new Set(perFile.flatMap((f) => f.packages));
    expect(allPackages.has('playwright')).toBe(true); // the import whose non-declaration motivated this guard
  });

  it('every bare import resolves to a declaration in apps/web or the workspace root package.json', () => {
    const violations = perFile
      .map(({ file, packages }) => ({ file, undeclared: packages.filter((p) => !declared.has(p)) }))
      .filter((v) => v.undeclared.length > 0);
    expect(violations, 'undeclared package imports in tools/** — declare them in apps/web/package.json (a transitively-hoisted package resolves today and breaks on the next unrelated install)').toEqual([]);
  });
});
