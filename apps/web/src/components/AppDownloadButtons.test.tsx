import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import {
  AppDownloadButtons,
  MOBILE_APP_REPO_URL,
} from './AppDownloadButtons';

const stylesCss = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

describe('AppDownloadButtons', () => {
  it('links both badges to the real companion repo while no install artifact exists', () => {
    const markup = renderToStaticMarkup(<AppDownloadButtons iosUrl="" androidUrl="" />);
    expect(markup).toContain(`href="${MOBILE_APP_REPO_URL}"`);
    expect(markup).toContain('Source &amp; builds');
    expect(markup).toContain('iOS app');
    expect(markup).toContain('Android app');
    // The broken-path bug: a download attribute on a URL that is not an
    // install file saves an HTML page to disk. Repo links must never carry it.
    expect(markup).not.toContain('download=');
    expect(markup).not.toContain('Coming soon');
    expect(markup).not.toContain('aria-disabled');
  });

  it('renders live store links as plain links when URLs are configured', () => {
    const markup = renderToStaticMarkup(
      <AppDownloadButtons
        iosUrl="https://apps.apple.com/app/sidestage/id0000000000"
        androidUrl="https://play.google.com/store/apps/details?id=com.sidestage.app"
      />,
    );
    expect(markup).toContain('href="https://apps.apple.com/app/sidestage/id0000000000"');
    expect(markup).toContain('href="https://play.google.com/store/apps/details?id=com.sidestage.app"');
    expect(markup).not.toContain('download=');
    expect(markup).not.toContain('Coming soon');
  });

  it('restores the download affordance for a genuine install file URL', () => {
    const markup = renderToStaticMarkup(
      <AppDownloadButtons
        iosUrl="https://cdn.example.com/builds/sidestage-ios.ipa"
        androidUrl="https://cdn.example.com/builds/sidestage-android.apk"
      />,
    );
    expect(markup).toContain('download="sidestage-ios.ipa"');
    expect(markup).toContain('download="sidestage-android.apk"');
    expect(markup).toContain('Download iOS');
    expect(markup).toContain('Download Android');
    expect(markup).toContain('App Store');
    expect(markup).toContain('Google Play');
  });

  it('falls back one platform at a time to the repo link', () => {
    const markup = renderToStaticMarkup(
      <AppDownloadButtons iosUrl="https://apps.apple.com/app/sidestage/id0000000000" androidUrl="" />,
    );
    expect(markup).toContain('href="https://apps.apple.com/app/sidestage/id0000000000"');
    expect(markup).toContain(`href="${MOBILE_APP_REPO_URL}"`);
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
    expect(markup).toContain('Source &amp; builds');
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
