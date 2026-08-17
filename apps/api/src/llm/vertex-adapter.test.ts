import { describe, expect, it, vi } from 'vitest';

import type { ScoutModelAdapter } from '@papercusp/scout-runtime';
import { createVertexAdapter, DEFAULT_VERTEX_MODEL } from './vertex-adapter';

const fakeAdapter = { model: 'constructed' } as unknown as ScoutModelAdapter;

describe('createVertexAdapter', () => {
  it('returns undefined without GOOGLE_CLOUD_PROJECT so credential-less clones boot deterministic', () => {
    const create = vi.fn(() => fakeAdapter);

    expect(createVertexAdapter(undefined, {}, create)).toBeUndefined();
    expect(createVertexAdapter(undefined, { GOOGLE_CLOUD_PROJECT: '   ' }, create)).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it('constructs the adapter with the default model and global location', () => {
    const create = vi.fn(() => fakeAdapter);

    const adapter = createVertexAdapter(undefined, { GOOGLE_CLOUD_PROJECT: 'proj-1' }, create);

    expect(adapter).toBe(fakeAdapter);
    expect(create).toHaveBeenCalledWith({
      model: DEFAULT_VERTEX_MODEL,
      project: 'proj-1',
      location: 'global',
    });
  });

  it('honors the per-seam model override and configured location', () => {
    const create = vi.fn(() => fakeAdapter);

    createVertexAdapter('gemini-custom', {
      GOOGLE_CLOUD_PROJECT: 'proj-1',
      GOOGLE_CLOUD_LOCATION: 'us-east1',
    }, create);

    expect(create).toHaveBeenCalledWith({
      model: 'gemini-custom',
      project: 'proj-1',
      location: 'us-east1',
    });
  });
});
