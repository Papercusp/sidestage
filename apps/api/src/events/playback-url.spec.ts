import { describe, expect, it } from 'vitest';
import { whepPlaybackUrl } from './playback-url';

describe('whepPlaybackUrl', () => {
  it('builds the full WHEP endpoint from the configured base', () => {
    expect(whepPlaybackUrl('sunday-drop', { MEDIAMTX_WHEP_URL: 'https://media.example.com' }))
      .toBe('https://media.example.com/sidestage-sunday-drop/whep');
  });

  it('tolerates a trailing slash on the base', () => {
    expect(whepPlaybackUrl('sunday-drop', { MEDIAMTX_WHEP_URL: 'http://mediamtx:8889/' }))
      .toBe('http://mediamtx:8889/sidestage-sunday-drop/whep');
  });

  it('answers null when the deployment has no media plane', () => {
    expect(whepPlaybackUrl('sunday-drop', {})).toBeNull();
    expect(whepPlaybackUrl('sunday-drop', { MEDIAMTX_WHEP_URL: '   ' })).toBeNull();
  });

  it('percent-encodes the stream path rather than trusting the id', () => {
    // Event ids are validated upstream to [a-z0-9-], so this is defence in
    // depth: an id that somehow carries a reserved character must not be able
    // to splice path segments into the media URL.
    expect(whepPlaybackUrl('a/b', { MEDIAMTX_WHEP_URL: 'https://media.example.com' }))
      .toBe('https://media.example.com/sidestage-a%2Fb/whep');
  });
});
