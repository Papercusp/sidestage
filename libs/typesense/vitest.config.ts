import { defineVitestConfig } from '@papercusp/test-config';

// See libs/chat-protocol/vitest.config.ts — without this file a workspace-local
// `vitest run` inherits the repository root config and runs the whole monorepo.
// The builder's baseExclude also keeps the compiled copies under dist/ out of
// the run; this package ships *.test.js/*.test.d.ts there.
export default defineVitestConfig({ layer: 'unit' });
