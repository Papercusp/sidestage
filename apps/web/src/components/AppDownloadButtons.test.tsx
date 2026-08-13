import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { AppDownloadButtons } from './AppDownloadButtons';

describe('AppDownloadButtons', () => {
  it('renders both store badges as coming-soon when no URLs are configured', () => {
    const markup = renderToStaticMarkup(<AppDownloadButtons iosUrl="" androidUrl="" />);
    expect(markup).toContain('App Store');
    expect(markup).toContain('Google Play');
    expect(markup).toContain('Coming soon');
    expect(markup).toContain('aria-disabled="true"');
    expect(markup).not.toContain('<a ');
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
    expect(markup).toContain('Download on');
    expect(markup).not.toContain('Coming soon');
    expect(markup).toContain('rel="noreferrer"');
  });

  it('mixes states independently per platform', () => {
    const markup = renderToStaticMarkup(
      <AppDownloadButtons iosUrl="https://apps.apple.com/app/sidestage/id0000000000" androidUrl="" />,
    );
    expect(markup).toContain('href="https://apps.apple.com/app/sidestage/id0000000000"');
    expect(markup).toContain('Coming soon');
  });

  it('ships in the app shell footer on every tab', () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain('app-badges');
    expect(markup).toContain('App Store');
    expect(markup).toContain('Google Play');
  });
});
