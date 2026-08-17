/**
 * Type-only bridge to @rocicorp/zero's server subpath exports.
 *
 * WHY THIS FILE EXISTS (P-011 / WI-39663): this project is on
 * `moduleResolution: "Node"` (node10), which predates package `exports` maps, so
 * TS cannot see `@rocicorp/zero/server` or `@rocicorp/zero/server/adapters/pg`
 * and reports TS2307 — even though Node resolves both correctly at runtime.
 *
 * The obvious fix, a tsconfig `paths` entry, is WRONG here and was actively
 * harmful: `paths` is not type-only, because tsx honours tsconfig paths at
 * runtime. Pointed at the `.d.ts`, tsx loaded the DECLARATION file, whose
 * `export * from '../../../zero-server/src/adapters/pg.ts'` names a `.ts` the
 * package does not ship -> MODULE_NOT_FOUND. ZeroController sits in AppModule's
 * graph, so that took the WHOLE API down under `npm run start:dev`, with
 * bootstrapWithRetry's /healthz still answering 200 the entire time. Pointed at
 * the `.js` it fails the other way (TS7016 — no declaration file found; TS does
 * not substitute the sibling `.d.ts` for a node10 `paths` target).
 *
 * An ambient module declaration is the right seam: it satisfies the TYPE
 * resolver only, and leaves runtime resolution to Node's exports map. Delete
 * this file if the project ever moves to `Bundler`/`NodeNext`, which reads the
 * exports map directly and makes it unnecessary.
 *
 * The relative targets are the exact files @rocicorp/zero's exports map names
 * for these two subpaths, so the types here cannot drift from what Node loads.
 */
declare module '@rocicorp/zero/server' {
  export * from '../../../../node_modules/@rocicorp/zero/out/zero/src/server';
}

declare module '@rocicorp/zero/server/adapters/pg' {
  export * from '../../../../node_modules/@rocicorp/zero/out/zero/src/adapters/pg';
}
