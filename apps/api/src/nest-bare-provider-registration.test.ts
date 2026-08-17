/**
 * Guard: a Nest class registered as a BARE provider must not have a constructor
 * parameter that Nest cannot inject.
 *
 * WHY THIS IS A STATIC TEST AND NOT A DI TEST
 * -------------------------------------------
 * EventActivationSweeper took the whole API down on 2026-08-17 with
 *
 *   UnknownDependenciesException: Nest can't resolve dependencies of the
 *   EventActivationSweeper (EventService, SyncInvalidationService, ?).
 *   Please make sure that the argument Number at index [2] is available.
 *
 * Its third constructor parameter is `intervalMs: number = <default>()`. Under
 * `tsc` (emitDecoratorMetadata: true) Nest reads design:paramtypes as
 * [EventService, SyncInvalidationService, Number], finds no provider for
 * `Number`, and refuses to build the module.
 *
 * The bug is invisible in dev and in this very test runner: tsx and vitest both
 * transpile with esbuild, which does NOT emit decorator metadata, so Nest sees
 * no paramtypes and the default quietly applies. A runtime DI test
 * (Test.createTestingModule) therefore PASSES on the broken registration — it
 * would be a guard that cannot fail. Only the compiled build breaks, which is
 * exactly what `npm start` runs.
 *
 * So we assert the SHAPE statically instead: if a class is listed bare in a
 * module's `providers`, every constructor parameter must be injectable —
 * decorated with @Inject(...) or of a non-primitive (class) type. The escape
 * hatch is the one chat.module.ts already used for ChatPresenceSweeper:
 * register it with an explicit `useFactory` so the defaulted parameter is never
 * injected at all.
 *
 * FALSIFIABILITY: the two `control fixture` cases below hold a deliberately
 * broken module + its corrected twin, permanently, in-repo. They prove the
 * detector both FIRES and does not false-positive, without ever mutating the
 * shared working tree (a copy-out/in-tree mutation probe can be committed by
 * the git-sync sweep mid-run — see CLAUDE.md "Proving a guard is falsifiable").
 */
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Overridable so falsifiability can be proven against a COPY of the tree
// (mutating the shared checkout risks the git-sync sweep committing the mutant).
const SRC = process.env.SIDESTAGE_API_SRC ?? __dirname;

const PRIMITIVE_KEYWORDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.BooleanKeyword,
  ts.SyntaxKind.SymbolKeyword,
  ts.SyntaxKind.BigIntKeyword,
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** Class name -> constructor parameters, for every class declared under `dir`. */
function collectClasses(files: string[]): Map<string, ts.ParameterDeclaration[]> {
  const classes = new Map<string, ts.ParameterDeclaration[]>();
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name) {
        const ctor = node.members.find(ts.isConstructorDeclaration);
        classes.set(node.name.text, ctor ? [...ctor.parameters] : []);
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
  }
  return classes;
}

/** Bare (identifier-only) entries of each @Module({ providers: [...] }) array. */
function collectBareProviders(files: string[]): { module: string; provider: string }[] {
  const found: { module: string; provider: string }[] = [];
  for (const file of files.filter((f) => f.endsWith('.module.ts'))) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Module') {
        const arg = node.arguments[0];
        if (arg && ts.isObjectLiteralExpression(arg)) {
          for (const prop of arg.properties) {
            if (
              ts.isPropertyAssignment(prop) &&
              ts.isIdentifier(prop.name) &&
              prop.name.text === 'providers' &&
              ts.isArrayLiteralExpression(prop.initializer)
            ) {
              for (const el of prop.initializer.elements) {
                if (ts.isIdentifier(el)) found.push({ module: file, provider: el.text });
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
  }
  return found;
}

/** A parameter Nest cannot resolve: no @Inject(...) and not a class type. */
function isUninjectable(param: ts.ParameterDeclaration): boolean {
  if ((ts.getDecorators(param) ?? []).length > 0) return false;
  if (param.type && PRIMITIVE_KEYWORDS.has(param.type.kind)) return true;
  // No type annotation but a default value => design:paramtypes is Object/undefined.
  if (!param.type && param.initializer) return true;
  return false;
}

interface ScanResult {
  moduleCount: number;
  classCount: number;
  bareProviderCount: number;
  violations: string[];
}

function scan(dir: string): ScanResult {
  const files = walk(dir);
  const classes = collectClasses(files);
  const bareProviders = collectBareProviders(files);
  const violations: string[] = [];

  for (const { module, provider } of bareProviders) {
    const params = classes.get(provider);
    if (!params) continue; // declared outside this tree — not ours to police
    for (const [index, param] of params.entries()) {
      if (!isUninjectable(param)) continue;
      const name = ts.isIdentifier(param.name) ? param.name.text : `#${index}`;
      violations.push(
        `${provider} is registered as a BARE provider in ${module.replace(dir, '.')}, ` +
          `but constructor param [${index}] '${name}' has no @Inject() and a non-injectable type. ` +
          `Under tsc's emitDecoratorMetadata Nest will try to inject it and the app will FAIL TO BOOT ` +
          `(this passes under vitest/tsx because esbuild emits no decorator metadata). ` +
          `Register it with an explicit useFactory instead — see ChatPresenceSweeper in src/chat/chat.module.ts.`,
      );
    }
  }

  return {
    moduleCount: files.filter((f) => f.endsWith('.module.ts')).length,
    classCount: classes.size,
    bareProviderCount: bareProviders.length,
    violations,
  };
}

function fixture(moduleBody: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'nest-provider-guard-'));
  writeFileSync(
    join(dir, 'sweeper.ts'),
    `export class FixtureService {}
     @Injectable()
     export class FixtureSweeper {
       constructor(
         @Inject(FixtureService) private readonly svc: FixtureService,
         private readonly intervalMs: number = 15_000,
       ) {}
     }`,
  );
  writeFileSync(join(dir, 'fixture.module.ts'), moduleBody);
  return dir;
}

describe('Nest bare provider registration', () => {
  const real = scan(SRC);

  it('control: the scanner actually finds this codebase (an empty scan would pass forever)', () => {
    expect(real.moduleCount).toBeGreaterThan(5);
    expect(real.classCount).toBeGreaterThan(20);
    expect(real.bareProviderCount).toBeGreaterThan(5);
  });

  it('control fixture: FIRES on a bare provider with an uninjectable param', () => {
    const dir = fixture(`@Module({ providers: [FixtureSweeper] })
                         export class FixtureModule {}`);
    const result = scan(dir);
    expect(result.bareProviderCount).toBe(1);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('FixtureSweeper');
    expect(result.violations[0]).toContain('intervalMs');
  });

  it('control fixture: does NOT fire once the same class is registered via useFactory', () => {
    const dir = fixture(`@Module({
                           providers: [
                             { provide: FixtureSweeper, inject: [FixtureService],
                               useFactory: (svc) => new FixtureSweeper(svc) },
                           ],
                         })
                         export class FixtureModule {}`);
    const result = scan(dir);
    expect(result.bareProviderCount).toBe(0);
    expect(result.violations).toEqual([]);
  });

  it('registers every bare-provider class with only injectable constructor params', () => {
    expect(real.violations).toEqual([]);
  });
});
