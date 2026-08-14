import { describe, expect, it } from 'vitest';
import { resolveDevServerEnvironment, stripDevApiPrefix } from '../vite.config';

describe('resolveDevServerEnvironment', () => {
  it('uses the reviewer-facing default ports', () => {
    expect(resolveDevServerEnvironment({})).toEqual({
      apiOrigin: 'http://localhost:3100',
      webPort: 5173,
    });
  });

  it('keeps concurrent dev servers isolated through environment overrides', () => {
    expect(
      resolveDevServerEnvironment({
        API_PORT: '3217',
        WEB_PORT: '5284',
      }),
    ).toEqual({
      apiOrigin: 'http://localhost:3217',
      webPort: 5284,
    });
  });

  it('honors an explicit API origin and removes trailing slashes', () => {
    expect(
      resolveDevServerEnvironment({
        API_PORT: '3217',
        VITE_API_URL: 'https://api.example.test///',
      }),
    ).toEqual({
      apiOrigin: 'https://api.example.test',
      webPort: 5173,
    });
  });

  it.each([
    ['WEB_PORT', '0'],
    ['WEB_PORT', '65536'],
    ['API_PORT', 'not-a-port'],
  ])('rejects an invalid %s value', (name, value) => {
    expect(() => resolveDevServerEnvironment({ [name]: value })).toThrow(
      `${name} must be an integer between 1 and 65535`,
    );
  });
});

describe('stripDevApiPrefix', () => {
  it('maps same-origin production API paths onto the bare local Nest routes', () => {
    expect(stripDevApiPrefix('/api/scout/chat/stream')).toBe('/scout/chat/stream');
    expect(stripDevApiPrefix('/api')).toBe('/');
    expect(stripDevApiPrefix('/catalog')).toBe('/catalog');
  });
});
