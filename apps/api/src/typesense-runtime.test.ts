import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('@papercusp/typesense runtime package', () => {
  it('routes JavaScript consumers to compiled output', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(__dirname, '../../../libs/typesense/package.json'), 'utf8'),
    ) as {
      main?: string;
      exports?: { '.'?: { import?: string; require?: string; default?: string } };
    };

    expect(packageJson.main).toBe('dist/index.js');
    expect(packageJson.exports?.['.']).toMatchObject({
      import: './dist/index.js',
      require: './dist/index.js',
      default: './dist/index.js',
    });
  });
});
