/**
 * The stranded-pin contract (WI-39864).
 *
 * The defect: a deep link named an event the owner created under a seller
 * identity their browser no longer resolves to, and the Studio's boards each
 * fetched it and each rendered the ownership guard's bare 404. The predicate
 * under test decides when the Studio stands down behind one identity notice
 * instead — and, just as load-bearing, when it must NOT (the create flow types
 * ids the directory cannot contain yet).
 */

import { describe, expect, it } from 'vitest';
import { strandedPinNotice, strandedUrlPin } from './stranded-pin';

const OWNED = [{ eventId: 'my-live-show' }, { eventId: 'my-draft' }] as const;

describe('strandedUrlPin (WI-39864)', () => {
  it('strands a URL pin the loaded directory does not contain', () => {
    expect(strandedUrlPin('avi-real-test', 'url', OWNED, false, null)).toBe('avi-real-test');
  });

  it('strands against an EMPTY loaded directory — the fresh-identity case', () => {
    // A rotated-to identity typically owns nothing yet; the deep link into the
    // old identity's event is exactly the reported repro.
    expect(strandedUrlPin('avi-real-test', 'url', [], false, null)).toBe('avi-real-test');
  });

  it('passes a URL pin the directory contains', () => {
    expect(strandedUrlPin('my-live-show', 'url', OWNED, false, null)).toBeNull();
  });

  it('never strands a pin the seller chose in this session', () => {
    // Typing a brand-new id then pressing Start is the create flow; blocking
    // it here would make event creation impossible.
    expect(strandedUrlPin('brand-new-room', 'user', OWNED, false, null)).toBeNull();
    expect(strandedUrlPin('brand-new-room', 'user', [], false, null)).toBeNull();
  });

  it('holds fire while the directory is loading', () => {
    // "Your directory has not arrived" and "you own no such event" must never
    // be conflated — same rule as activeEventStatus's explicit loading arg.
    expect(strandedUrlPin('avi-real-test', 'url', [], true, null)).toBeNull();
  });

  it('holds fire when the directory query errored', () => {
    // An unreachable directory says nothing about ownership; the boards'
    // own error reporting is the honest fallback there.
    expect(strandedUrlPin('avi-real-test', 'url', [], false, new Error('boom'))).toBeNull();
  });

  it('does nothing when the URL pinned no event', () => {
    expect(strandedUrlPin(null, 'url', OWNED, false, null)).toBeNull();
    expect(strandedUrlPin(null, 'url', [], false, null)).toBeNull();
  });
});

describe('strandedPinNotice (WI-39864)', () => {
  it('names the event, the current identity, and both readings', () => {
    const notice = strandedPinNotice('avi-real-test', 'seller-jhglds');
    expect(notice.body).toContain('"avi-real-test"');
    expect(notice.body).toContain('seller-jhglds');
    // The guard deliberately conflates missing and foreign, so the copy must
    // offer BOTH recoveries rather than guess at one.
    expect(notice.identityHint).toContain('identity control in the top bar');
    expect(notice.identityHint).toContain('stale');
    expect(notice.action).toBe('Show my events instead');
  });
});
