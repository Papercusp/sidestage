import type { ScoutModelAdapter, VertexGeminiAdapterOptions } from '@papercusp/scout-runtime';
import { describe, expect, it, vi } from 'vitest';
import { createScoutRuntimeModel } from './scout.module';

const runtimeModel = { model: 'vertex-double' } as ScoutModelAdapter;

describe('Scout runtime model configuration', () => {
  it('leaves the runtime model absent when Vertex has no explicit project', () => {
    const create = vi.fn(() => runtimeModel);

    expect(createScoutRuntimeModel({
      SCOUT_VERTEX_MODEL: 'gemini-test',
      GOOGLE_CLOUD_LOCATION: 'us-central1',
    }, create)).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
  });

  it('constructs Vertex only when its project is configured', () => {
    const create = vi.fn((_options: VertexGeminiAdapterOptions) => runtimeModel);

    expect(createScoutRuntimeModel({
      GOOGLE_CLOUD_PROJECT: '  sidestage-prod  ',
      GOOGLE_CLOUD_LOCATION: '  us-central1  ',
      SCOUT_VERTEX_MODEL: '  gemini-test  ',
    }, create)).toBe(runtimeModel);
    expect(create).toHaveBeenCalledWith({
      project: 'sidestage-prod',
      location: 'us-central1',
      model: 'gemini-test',
    });
  });
});
