import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('uses the documented global location and Gemini model defaults', () => {
    const create = vi.fn((_options: VertexGeminiAdapterOptions) => runtimeModel);

    expect(createScoutRuntimeModel({
      GOOGLE_CLOUD_PROJECT: 'sidestage-prod',
      GOOGLE_CLOUD_LOCATION: '   ',
      SCOUT_VERTEX_MODEL: '   ',
    }, create)).toBe(runtimeModel);
    expect(create).toHaveBeenCalledWith({
      project: 'sidestage-prod',
      location: 'global',
      model: 'gemini-3.1-pro-preview-customtools',
    });
  });

  it('forwards optional Vertex configuration into the production API container', () => {
    const compose = readFileSync(
      resolve(__dirname, '../../../../docker-compose.prod.yml'),
      'utf8',
    );
    const api = compose.match(/\n  api:\n([\s\S]*?)(?=\n  [a-z][\w-]*:\n)/)?.[1] ?? '';

    expect(api).toContain('GOOGLE_CLOUD_PROJECT: ${GOOGLE_CLOUD_PROJECT:-}');
    expect(api).toContain('GOOGLE_CLOUD_LOCATION: ${GOOGLE_CLOUD_LOCATION:-}');
    expect(api).toContain('SCOUT_VERTEX_MODEL: ${SCOUT_VERTEX_MODEL:-}');
  });
});
