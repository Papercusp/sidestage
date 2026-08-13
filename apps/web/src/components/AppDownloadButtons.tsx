const env = import.meta.env as Record<string, string | undefined>;

/** Store links for the mobile apps. Configure via Vite env at build time;
 * blank/absent renders the badge in an accessible "coming soon" state so the
 * buttons can ship ahead of the store listings. */
const DEFAULT_IOS_URL = (env.VITE_IOS_APP_URL ?? '').trim();
const DEFAULT_ANDROID_URL = (env.VITE_ANDROID_APP_URL ?? '').trim();

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
  const live = href.length > 0;
  const body = (
    <>
      <span className="app-badge-hint">{live ? 'Download on' : 'Coming soon'}</span>
      <span className="app-badge-name">{storeName}</span>
    </>
  );
  if (!live) {
    return (
      <span
        className="app-badge is-soon"
        aria-disabled="true"
        title={`The SideStage ${platform === 'ios' ? 'iPhone' : 'Android'} app is coming soon`}
        data-platform={platform}
      >
        {body}
      </span>
    );
  }
  return (
    <a
      className="app-badge"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Download the SideStage ${platform === 'ios' ? 'iPhone' : 'Android'} app on ${storeName}`}
      data-platform={platform}
    >
      {body}
    </a>
  );
}

export function AppDownloadButtons({
  iosUrl = DEFAULT_IOS_URL,
  androidUrl = DEFAULT_ANDROID_URL,
}: AppDownloadButtonsProps) {
  return (
    <div className="app-badges" aria-label="Get the SideStage app">
      <AppBadge href={iosUrl} platform="ios" storeName="App Store" />
      <AppBadge href={androidUrl} platform="android" storeName="Google Play" />
    </div>
  );
}
