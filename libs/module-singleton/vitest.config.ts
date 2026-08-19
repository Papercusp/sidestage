import { defineVitestConfig } from '@papercusp/test-config';

// See libs/chat-protocol/vitest.config.ts — without this file a workspace-local
// `vitest run` inherits the repository root config and runs the whole monorepo.
export default defineVitestConfig({ layer: 'unit' });
