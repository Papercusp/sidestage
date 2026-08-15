import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CHANNEL_GUIDE_ACTIVE_NOW_LABEL,
  ChannelGuideActiveNow,
  channelGuideActiveNowRowClass,
} from './ChannelGuideActiveNow';

const activeNowCss = readFileSync(new URL('./channel-guide-active-now.css', import.meta.url), 'utf8');

describe('ChannelGuideActiveNow', () => {
  it('applies the Signal rail hook only to genuinely live rows', () => {
    expect(channelGuideActiveNowRowClass('live')).toBe(' is-active-now');
    expect(channelGuideActiveNowRowClass('scheduled')).toBe('');
    expect(channelGuideActiveNowRowClass('ended')).toBe('');
  });

  it('states live status and viewer count independently without borrowing current-room semantics', () => {
    const markup = renderToStaticMarkup(<ChannelGuideActiveNow watchingLabel="128 watching" />);

    expect(CHANNEL_GUIDE_ACTIVE_NOW_LABEL).toBe('Live now');
    expect(markup).toContain('Live now');
    expect(markup).toContain('128 watching');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('Currently watching');
    expect(markup).not.toContain('aria-current');
  });

  it('carries the approved rail, tint, compact pill, and token-only color contract', () => {
    expect(activeNowCss).toMatch(/\.channel-guide-row\.is-active-now\s*\{/);
    expect(activeNowCss).toContain('box-shadow: inset .24rem 0 0 var(--brand-red)');
    expect(activeNowCss).toMatch(/\.channel-guide-active-now-badge\s*\{[^}]*border-radius:\s*999px/s);
    expect(activeNowCss).toContain('var(--on-brand-red)');
    expect(activeNowCss).toContain('var(--red-text)');
    expect(activeNowCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('keeps narrow rows readable without hiding either semantic', () => {
    expect(activeNowCss).toMatch(/@media \(max-width: 24rem\)/);
    expect(activeNowCss).toMatch(/\.channel-guide-active-now\s*\{[^}]*flex-direction:\s*column/s);
    expect(activeNowCss).not.toMatch(/display:\s*none/);
  });
});
