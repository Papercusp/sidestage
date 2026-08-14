import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import {
  ANDROID_INSTALL_STUB_URL,
  AppDownloadButtons,
  IOS_INSTALL_STUB_URL,
} from './AppDownloadButtons';

const stylesCss = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('AppDownloadButtons', () => {
  it('renders both store badges as download links backed by stable install-file stubs', () => {
    const markup = renderToStaticMarkup(<AppDownloadButtons iosUrl="" androidUrl="" />);
    expect(markup).toContain('App Store');
    expect(markup).toContain('Google Play');
    expect(markup).toContain(`href="${IOS_INSTALL_STUB_URL}"`);
    expect(markup).toContain(`href="${ANDROID_INSTALL_STUB_URL}"`);
    expect(markup).toContain('download="sidestage-ios.ipa"');
    expect(markup).toContain('download="sidestage-android.apk"');
    expect(markup).not.toContain('Coming soon');
    expect(markup).not.toContain('aria-disabled');
  });

  it('renders live store links when URLs are configured', () => {
    const markup = renderToStaticMarkup(
      <AppDownloadButtons
        iosUrl="https://apps.apple.com/app/sidestage/id0000000000"
        androidUrl="https://play.google.com/store/apps/details?id=com.sidestage.app"
      />,
    );
    expect(markup).toContain('href="https://apps.apple.com/app/sidestage/id0000000000"');
    expect(markup).toContain('href="https://play.google.com/store/apps/details?id=com.sidestage.app"');
    expect(markup).toContain('Download iOS');
    expect(markup).toContain('Download Android');
    expect(markup).not.toContain('Coming soon');
  });

  it('falls back one platform at a time without disabling either download', () => {
    const markup = renderToStaticMarkup(
      <AppDownloadButtons iosUrl="https://apps.apple.com/app/sidestage/id0000000000" androidUrl="" />,
    );
    expect(markup).toContain('href="https://apps.apple.com/app/sidestage/id0000000000"');
    expect(markup).toContain(`href="${ANDROID_INSTALL_STUB_URL}"`);
    expect(markup).not.toContain('aria-disabled');
  });

  it('ships immediately beside the wordmark in the top navbar, not in the footer', () => {
    const markup = renderToStaticMarkup(<App />);
    const wordmarkIndex = markup.indexOf('class="wordmark"');
    const badgesIndex = markup.indexOf('class="app-badges"');
    const navIndex = markup.indexOf('class="tab-nav"');
    const footerIndex = markup.indexOf('class="footer"');

    expect(markup).toContain('class="topbar-brand-group"');
    expect(markup).toContain('app-badges');
    expect(markup).toContain('App Store');
    expect(markup).toContain('Google Play');
    expect(wordmarkIndex).toBeGreaterThan(-1);
    expect(wordmarkIndex).toBeLessThan(badgesIndex);
    expect(badgesIndex).toBeLessThan(navIndex);
    expect(markup.slice(footerIndex)).not.toContain('class="app-badges"');
  });

  it('uses the two high-contrast brand fills for hard-to-miss navbar actions', () => {
    expect(stylesCss).toMatch(/\.app-badge\[data-platform="ios"\]\s*\{[^}]*background:\s*var\(--brand-red\)/);
    expect(stylesCss).toMatch(/\.app-badge\[data-platform="android"\]\s*\{[^}]*background:\s*var\(--brand-yellow\)/);
  });
});
