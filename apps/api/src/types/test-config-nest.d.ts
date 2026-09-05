/**
 * Local type surface for `@papercusp/test-config/nest`.
 *
 * WHY THIS FILE EXISTS. The package is declared at the workspace root and
 * vitest resolves the subpath fine, but `tsc` cannot see it from apps/api:
 *
 *   - the root tsconfig uses `moduleResolution: "Bundler"`, which reads
 *     `exports` maps, but apps/api OVERRIDES it to `"Node"` (node10) so Nest
 *     can emit CommonJS — and node10 predates `exports` entirely, so the
 *     "./nest" subpath is invisible (TS2307);
 *   - the `paths` escape hatch used above for @rocicorp/zero does not work
 *     here, because those targets are `.d.ts` files while this one is real
 *     `.ts` SOURCE. apps/api emits from rootDir `src`, so aliasing a file
 *     under libs/ into the program fails TS6059.
 *
 * So the subpath is declared locally. This is TYPES ONLY — the import still
 * binds to the one shared helper at runtime, and there is no second
 * implementation to drift from. The surface is narrowed to what the API tests
 * actually call; anything unlisted fails to compile rather than going
 * silently untyped.
 *
 * DELETE THIS FILE when apps/api moves to node16/nodenext/bundler resolution,
 * which is also the note left on the @rocicorp/zero paths block.
 */
/**
 * The BARREL, declared here for the same node10-resolution reason as the
 * subpath below. Narrowed to the hermetic-database helpers the pg-gated
 * isolation suite calls (event-access.pg-isolation.test.ts).
 */
declare module '@papercusp/test-config' {
  /** A throwaway database on the reused test container, plus its teardown. */
  export interface MigratedTestDb {
    /** Connection string for the freshly created database. */
    url: string;
    /** Generated database name. */
    name: string;
    /** Drop the database; serialised behind the shared drop lock. */
    drop: () => Promise<unknown>;
  }

  /** Create a fresh database and apply an ordered list of .sql file paths. */
  export function createMigratedTestDb(sqlFilePaths: string[]): Promise<MigratedTestDb>;
}

declare module '@papercusp/test-config/nest' {
  import type { INestApplication, ModuleMetadata } from '@nestjs/common';

  /** One HTTP response, reduced to what assertions read. */
  export interface NestTestResponse {
    status: number;
    body: unknown;
  }

  /** A chainable supertest request; awaiting it performs the call. */
  export interface NestTestRequest extends PromiseLike<NestTestResponse> {
    set(name: string, value: string): NestTestRequest;
    send(body?: unknown): NestTestRequest;
    /** supertest's inline status assertion; throws on mismatch. */
    expect(status: number): NestTestRequest;
  }

  /** The supertest agent bound to the in-process server (no port opened). */
  export interface NestTestAgent {
    get(url: string): NestTestRequest;
    post(url: string): NestTestRequest;
    put(url: string): NestTestRequest;
    patch(url: string): NestTestRequest;
    delete(url: string): NestTestRequest;
  }

  export interface NestTestApp {
    app: INestApplication;
    /** Nest's injector, for reading real providers by token. */
    module: {
      get<T = unknown>(token: unknown, options?: { strict?: boolean }): T;
    };
    request: NestTestAgent;
    close: () => Promise<void>;
  }

  export interface BootNestTestAppOptions {
    metadata: ModuleMetadata;
    configure?: (builder: unknown) => unknown;
    setup?: (app: INestApplication) => void | Promise<void>;
  }

  export function bootNestTestApp(opts: BootNestTestAppOptions): Promise<NestTestApp>;
}
