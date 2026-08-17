// SPDX-License-Identifier: MIT
import {
  VertexGeminiAdapter,
  type ScoutModelAdapter,
  type VertexGeminiAdapterOptions,
} from '@papercusp/scout-runtime';

export const DEFAULT_VERTEX_MODEL = 'gemini-3.1-pro-preview-customtools';

type VertexAdapterFactory = (options: VertexGeminiAdapterOptions) => ScoutModelAdapter;

/**
 * Env-gated Vertex adapter shared by the Copilot and Judge model seams (Scout
 * keeps its own gate in scout.module.ts with its own model env var). Returns
 * undefined when GOOGLE_CLOUD_PROJECT is absent so a clone without Google
 * credentials boots with the deterministic engines untouched. Call this only
 * inside a module provider factory — constructing the adapter at import time
 * without credentials makes the app non-bootable.
 */
export function createVertexAdapter(
  modelOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
  create: VertexAdapterFactory = (options) => new VertexGeminiAdapter(options),
): ScoutModelAdapter | undefined {
  const project = env.GOOGLE_CLOUD_PROJECT?.trim();
  if (!project) return undefined;

  return create({
    model: modelOverride?.trim() || DEFAULT_VERTEX_MODEL,
    project,
    location: env.GOOGLE_CLOUD_LOCATION?.trim() || 'global',
  });
}
