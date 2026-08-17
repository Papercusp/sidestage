const env = import.meta.env as Record<string, string | undefined>;

/**
 * Where the badges send people while no signed mobile artifact exists: the
 * public companion repo that holds the native iOS/Android apps. The previous
 * `/downloads/sidestage-*.{ipa,apk}` stubs were paths nothing served, so the
 * SPA catch-all answered them with the HTML shell — a button that "downloads"
 * a web page. A real destination beats a fake download.
 */
export const MOBILE_APP_REPO_URL = 'https://github.com/Papercusp/sidestage-mobile';

const DEFAULT_IOS_URL = (env.VITE_IOS_APP_URL ?? '').trim() || MOBILE_APP_REPO_URL;
const DEFAULT_ANDROID_URL = (env.VITE_ANDROID_APP_URL ?? '').trim() || MOBILE_APP_REPO_URL;

/**
 * Only a genuine install file gets the `download` attribute and download
 * labels. Store pages, the companion repo, or any other URL renders as a
 * plain link — a `download` attribute on those saves an HTML page to disk,
 * which is exactly the broken-path bug this component shipped with.
 */
function isInstallFile(href: string): boolean {
  return /\.(ipa|apk)(?:[?#]|$)/i.test(href);
}

type AppDownloadButtonsProps = {
  iosUrl?: string;
  androidUrl?: string;
};

type BadgeProps = {
  href: string;
  platform: 'ios' | 'android';
  storeName: string;
};

function AppBadge({ href, platform, storeName }: BadgeProps) {
  const platformName = platform === 'ios' ? 'iOS' : 'Android';
  if (isInstallFile(href)) {
    const downloadName = platform === 'ios' ? 'sidestage-ios.ipa' : 'sidestage-android.apk';
    return (
      <a
        className="app-badge"
        href={href}
        download={downloadName}
        aria-label={`Download the SideStage ${platform === 'ios' ? 'iPhone' : 'Android'} install file — ${storeName}`}
        data-platform={platform}
      >
        <span className="app-badge-hint">Download {platformName}</span>
        <span className="app-badge-name">{storeName}</span>
      </a>
    );
  }
  return (
    <a
      className="app-badge"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`SideStage for ${platform === 'ios' ? 'iPhone' : 'Android'} — source and builds on GitHub`}
      data-platform={platform}
    >
      <span className="app-badge-hint">{platformName} app</span>
      <span className="app-badge-name">Source &amp; builds</span>
    </a>
  );
}

export function AppDownloadButtons({
  iosUrl = DEFAULT_IOS_URL,
  androidUrl = DEFAULT_ANDROID_URL,
}: AppDownloadButtonsProps) {
  const resolvedIosUrl = iosUrl.trim() || MOBILE_APP_REPO_URL;
  const resolvedAndroidUrl = androidUrl.trim() || MOBILE_APP_REPO_URL;

  return (
    <div className="app-badges" aria-label="Get the SideStage app">
      <AppBadge href={resolvedIosUrl} platform="ios" storeName="App Store" />
      <AppBadge href={resolvedAndroidUrl} platform="android" storeName="Google Play" />
    </div>
  );
}
