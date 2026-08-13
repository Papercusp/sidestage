import { describe, it, expect } from 'vitest';
import { buildNumTypos } from './client';

// `buildNumTypos` produces the per-field Typesense `num_typos` CSV. Field order
// matches query_by: name, description, brand (+ an embedding placeholder 0 in
// semantic mode). `maxTypos` clamps every field DOWN — the latency knob the
// header autocomplete uses (maxTypos: 1).
describe('buildNumTypos', () => {
  it('keyword mode → name/desc 2, brand 1 (no embedding slot)', () => {
    expect(buildNumTypos(false)).toBe('2,2,1');
  });

  it('semantic mode → appends the embedding placeholder 0', () => {
    expect(buildNumTypos(true)).toBe('2,2,1,0');
  });

  it('maxTypos clamps every field DOWN (keyword)', () => {
    expect(buildNumTypos(false, 1)).toBe('1,1,1'); // type-ahead default
    expect(buildNumTypos(false, 0)).toBe('0,0,0'); // exact-only
  });

  it('maxTypos clamps fields but keeps the embedding placeholder at 0 (semantic)', () => {
    expect(buildNumTypos(true, 1)).toBe('1,1,1,0');
    expect(buildNumTypos(true, 0)).toBe('0,0,0,0');
  });

  it('a cap at/above the defaults is a no-op (never raises a field)', () => {
    expect(buildNumTypos(false, 2)).toBe('2,2,1'); // brand stays 1, not raised to 2
    expect(buildNumTypos(true, 5)).toBe('2,2,1,0');
  });

  it('omitting maxTypos uses the defaults', () => {
    expect(buildNumTypos(false, undefined)).toBe('2,2,1');
    expect(buildNumTypos(true, undefined)).toBe('2,2,1,0');
  });
});
