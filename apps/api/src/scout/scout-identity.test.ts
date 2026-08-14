import { describe, expect, it } from 'vitest';
import {
  AnonymousScoutIdentityResolver,
  BUYER_COOKIE,
  CookieScoutIdentityResolver,
  isUsableBuyerId,
  parseCookies,
  stripClientIdentity,
} from './scout-identity';

describe('parseCookies', () => {
  it('parses a normal multi-cookie header', () => {
    expect(parseCookies('a=1; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('percent-decodes values', () => {
    expect(parseCookies('id=user%40example.com')).toEqual({ id: 'user@example.com' });
  });

  it('keeps a malformed encoding rather than throwing', () => {
    // A bad cookie must degrade the turn to guest, never fail it.
    expect(parseCookies('id=%E0%A4%A')).toEqual({ id: '%E0%A4%A' });
  });

  it('handles values containing "="', () => {
    expect(parseCookies('token=abc=def')).toEqual({ token: 'abc=def' });
  });

  it('ignores empty, nameless and absent headers', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
    expect(parseCookies('=novalue; ; x=1')).toEqual({ x: '1' });
  });
});

describe('isUsableBuyerId', () => {
  it('accepts ordinary ids', () => {
    expect(isUsableBuyerId('buyer-1')).toBe(true);
    expect(isUsableBuyerId('user_42.a:b')).toBe(true);
  });

  it('rejects ids that would pollute the scope keyspace', () => {
    // The value becomes a `user:<id>` scope string, so an unbounded or
    // structured cookie would let a visitor mint arbitrary scopes.
    expect(isUsableBuyerId('')).toBe(false);
    expect(isUsableBuyerId('a'.repeat(129))).toBe(false);
    expect(isUsableBuyerId('has space')).toBe(false);
    expect(isUsableBuyerId('drop;table')).toBe(false);
    expect(isUsableBuyerId(undefined)).toBe(false);
    expect(isUsableBuyerId(null)).toBe(false);
  });
});

describe('CookieScoutIdentityResolver', () => {
  const resolver = new CookieScoutIdentityResolver();

  it('resolves the buyer id from the cookie', () => {
    expect(resolver.resolve({ cookie: `${BUYER_COOKIE}=buyer-1` })).toEqual({
      buyerId: 'buyer-1',
    });
  });

  it('is a guest with no cookie, no header, or an unusable id', () => {
    expect(resolver.resolve({})).toEqual({ buyerId: null });
    expect(resolver.resolve({ cookie: 'other=1' })).toEqual({ buyerId: null });
    expect(resolver.resolve({ cookie: `${BUYER_COOKIE}=has space` })).toEqual({ buyerId: null });
  });

  it('reads a repeated cookie header (string[])', () => {
    expect(resolver.resolve({ cookie: ['a=1', `${BUYER_COOKIE}=buyer-2`] })).toEqual({
      buyerId: 'buyer-2',
    });
  });

  it('reads ONLY headers — a body cannot reach it', () => {
    // The resolver's signature takes headers alone; this pins that the
    // trust boundary cannot be widened by passing a body-shaped object.
    expect(resolver.resolve({ buyerId: 'forged' } as never)).toEqual({ buyerId: null });
  });
});

describe('AnonymousScoutIdentityResolver', () => {
  it('makes everyone a guest', () => {
    expect(new AnonymousScoutIdentityResolver().resolve()).toEqual({ buyerId: null });
  });
});

describe('stripClientIdentity', () => {
  it('removes every client-supplied identity key', () => {
    const body = {
      message: 'hi',
      buyerId: 'forged',
      userId: 'forged',
      customerId: 'forged',
    };
    expect(stripClientIdentity(body)).toEqual({ message: 'hi' });
  });

  it('does not mutate the caller’s object', () => {
    const body = { message: 'hi', buyerId: 'forged' };
    stripClientIdentity(body);
    expect(body.buyerId).toBe('forged');
  });

  it('preserves every non-identity field', () => {
    const body = { message: 'hi', cartId: 'c1', eventId: 'e1', turnId: 't1', maxProducts: 3 };
    expect(stripClientIdentity(body)).toEqual(body);
  });

  it('passes through non-objects unharmed', () => {
    expect(stripClientIdentity(undefined)).toBeUndefined();
    expect(stripClientIdentity(null)).toBeNull();
  });
});
