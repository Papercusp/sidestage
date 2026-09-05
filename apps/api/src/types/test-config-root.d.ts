/**
 * Type-only shim for the ROOT `@papercusp/test-config` entry.
 *
 * Why this exists (P-008, plan sidestage-demo-user-isolation-2026-08-14):
 * the real package entry resolves to `libs/test-config/src/index.ts`, so importing
 * it pulls that whole library's SOURCE into apps/api's TypeScript program, where it
 * is compiled under apps/api's options rather than its own. Two of its choices are
 * illegal here: explicit `.ts` import extensions (TS5097) and `import.meta`
 * (TS1343, because apps/api is CommonJS). The library is perfectly valid on its own
 * config — the mismatch is entirely an artefact of cross-package source resolution.
 *
 * `tsconfig.json` redirects the specifier here via `paths`, so the type resolver
 * stops at this declaration and never opens the library's sources. Runtime is
 * unaffected: vitest resolves through vite and loads the real module. This mirrors
 * `test-config-nest.d.ts` (same trick for the `/nest` subpath) and the
 * `@rocicorp/zero/*` entries already in that same `paths` block.
 *
 * Declare only what apps/api actually imports. The durable fix — having
 * test-config ship built declarations so no shim is needed — is EI-22383491035147414.
 */
declare module '@papercusp/test-config' {
  /** A throwaway Postgres database with the given SQL files already applied. */
  export interface MigratedTestDb {
    /** Connection URL for the provisioned database. */
    readonly url: string;
    /**
     * Drop the database. I/O-heavy and serialised behind a shared lock, so give
     * the calling hook a budget well above vitest's 10s default.
     */
    drop(): Promise<void>;
  }

  /**
   * Provision a throwaway database on a reused test container and apply each SQL
   * file in order. Deliberately does not dial any shared dev database.
   */
  export function createMigratedTestDb(schemaFiles: string[]): Promise<MigratedTestDb>;
}
