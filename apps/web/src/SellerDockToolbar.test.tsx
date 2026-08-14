import { readFileSync } from 'node:fs';
import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  SellerDockToolbar,
  toggleSellerDockFullscreen,
  type SellerDockFullscreenDocument,
  type SellerDockFullscreenTarget,
} from './SellerDockToolbar';

describe('seller dock fullscreen', () => {
  it('enters the whole shell through the native Fullscreen API', async () => {
    const target: SellerDockFullscreenTarget = {
      requestFullscreen: vi.fn().mockResolvedValue(undefined),
    };
    const fullscreenDocument: SellerDockFullscreenDocument = {
      fullscreenElement: null,
      exitFullscreen: vi.fn().mockResolvedValue(undefined),
    };

    await expect(toggleSellerDockFullscreen(target, fullscreenDocument)).resolves.toBe(true);
    expect(target.requestFullscreen).toHaveBeenCalledOnce();
    expect(fullscreenDocument.exitFullscreen).not.toHaveBeenCalled();
  });

  it('exits when the seller shell is already fullscreen', async () => {
    const target: SellerDockFullscreenTarget = {
      requestFullscreen: vi.fn().mockResolvedValue(undefined),
    };
    const fullscreenDocument: SellerDockFullscreenDocument = {
      fullscreenElement: target,
      exitFullscreen: vi.fn().mockResolvedValue(undefined),
    };

    await expect(toggleSellerDockFullscreen(target, fullscreenDocument)).resolves.toBe(false);
    expect(fullscreenDocument.exitFullscreen).toHaveBeenCalledOnce();
    expect(target.requestFullscreen).not.toHaveBeenCalled();
  });

  it('reports an unsupported Fullscreen API instead of failing silently', async () => {
    await expect(
      toggleSellerDockFullscreen({}, { fullscreenElement: null }),
    ).rejects.toThrow('Fullscreen is not supported in this browser.');
  });

  it('renders both board controls with an accessible fullscreen state', () => {
    const markup = renderToStaticMarkup(
      <SellerDockToolbar fullscreenTargetRef={createRef<HTMLDivElement>()}>
        <span>Shared seller identity</span>
      </SellerDockToolbar>,
    );

    expect(markup).toContain('Shared seller identity');
    expect(markup).toContain('Enter fullscreen');
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('Reset layout');
  });

  it('fills available page space by default and overrides saved geometry only in fullscreen', () => {
    const css = readFileSync(new URL('./seller-dock.css', import.meta.url), 'utf8');

    expect(css).toMatch(
      /\.content\.content-seller\s*\{[^}]*width:\s*100%;[^}]*margin:\s*0;[^}]*padding:\s*0;/s,
    );
    expect(css).toMatch(
      /\.content-seller \.seller-dock-board:not\(\[style\]\)\s*\{[^}]*flex:\s*1 1 auto;/s,
    );
    expect(css).toMatch(
      /\.seller-dock-shell:fullscreen \.seller-dock-board\s*\{[^}]*width:\s*100% !important;[^}]*height:\s*auto !important;/s,
    );
  });
});
