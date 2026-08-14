const env = import.meta.env as Record<string, string | undefined>;

/** Stable install-file stubs keep the navbar controls as real links before the
 * signed mobile artifacts exist. Deployments can replace either URL at build
 * time without changing the component or its placement. */
export const IOS_INSTALL_STUB_URL = '/downloads/sidestage-ios.ipa';
export const ANDROID_INSTALL_STUB_URL = '/downloads/sidestage-android.apk';

const DEFAULT_IOS_URL = (env.VITE_IOS_APP_URL ?? '').trim() || IOS_INSTALL_STUB_URL;
const DEFAULT_ANDROID_URL = (env.VITE_ANDROID_APP_URL ?? '').trim() || ANDROID_INSTALL_STUB_URL;

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
  const downloadName = platform === 'ios' ? 'sidestage-ios.ipa' : 'sidestage-android.apk';
  return (
    <a
      className="app-badge"
      href={href}
      download={downloadName}
      aria-label={`Download the SideStage ${platform === 'ios' ? 'iPhone' : 'Android'} install file — ${storeName}`}
      data-platform={platform}
    >
      <>
        <span className="app-badge-hint">Download {platform === 'ios' ? 'iOS' : 'Android'}</span>
        <span className="app-badge-name">{storeName}</span>
      </>
    </a>
  );
}

export function AppDownloadButtons({
  iosUrl = DEFAULT_IOS_URL,
  androidUrl = DEFAULT_ANDROID_URL,
}: AppDownloadButtonsProps) {
  const resolvedIosUrl = iosUrl.trim() || IOS_INSTALL_STUB_URL;
  const resolvedAndroidUrl = androidUrl.trim() || ANDROID_INSTALL_STUB_URL;

  return (
    <div className="app-badges" aria-label="Get the SideStage app">
      <AppBadge href={resolvedIosUrl} platform="ios" storeName="App Store" />
      <AppBadge href={resolvedAndroidUrl} platform="android" storeName="Google Play" />
    </div>
  );
}
