import './active-now-comparison.css';

export const ACTIVE_NOW_COMPARISON_PATH = '/design/channel-guide-active-now';

export function isActiveNowComparisonPath(pathname: string): boolean {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  return normalized === ACTIVE_NOW_COMPARISON_PATH;
}

type ActiveNowVariant = 'signal-rail' | 'spotlight-wash' | 'thumbnail-flag';

interface ComparisonOption {
  id: ActiveNowVariant;
  number: string;
  title: string;
  summary: string;
  statusLabel: string;
  strength: string;
  bestFor: string;
  recommended?: boolean;
}

const OPTIONS: readonly ComparisonOption[] = [
  {
    id: 'signal-rail',
    number: 'Option A',
    title: 'Signal rail',
    summary: 'A slim red rail, light tint, and compact status pill make the live row easy to scan without changing its shape.',
    statusLabel: 'Active now',
    strength: 'Balanced',
    bestFor: 'Everyday use',
    recommended: true,
  },
  {
    id: 'spotlight-wash',
    number: 'Option B',
    title: 'Spotlight wash',
    summary: 'A stronger tinted surface and larger status cluster give the live room the most promotional energy.',
    statusLabel: 'Happening now',
    strength: 'High emphasis',
    bestFor: 'Launch moments',
  },
  {
    id: 'thumbnail-flag',
    number: 'Option C',
    title: 'Thumbnail flag',
    summary: 'The live signal sits on the thumbnail, keeping the row quiet while still adding a clear, non-color label.',
    statusLabel: 'Live',
    strength: 'Light touch',
    bestFor: 'Dense schedules',
  },
];

function PreviewThumbnail({ label, liveFlag }: { label: string; liveFlag?: string }) {
  return (
    <span className="active-now-thumb" aria-hidden="true">
      <span className="active-now-thumb-mark">{label}</span>
      {liveFlag ? <span className="active-now-thumb-flag">{liveFlag}</span> : null}
    </span>
  );
}

function LiveEventRow({ option }: { option: ComparisonOption }) {
  const thumbnailFlag = option.id === 'thumbnail-flag' ? option.statusLabel : undefined;

  return (
    <li>
      <a
        className={`active-now-event-row is-live variant-${option.id}`}
        href="/?tab=buyer&event=vinyl-after-dark"
        aria-label={`Vinyl After Dark by Needle & Groove. ${option.statusLabel}. 128 watching. Currently watching.`}
      >
        <PreviewThumbnail label="V" liveFlag={thumbnailFlag} />
        <span className="active-now-event-copy">
          <span className="active-now-event-status">
            {option.id !== 'thumbnail-flag' ? (
              <span className="active-now-live-badge">
                <span className="active-now-live-dot" aria-hidden="true" />
                {option.statusLabel}
              </span>
            ) : (
              <span className="active-now-live-text">
                <span className="active-now-live-dot" aria-hidden="true" />
                Active now
              </span>
            )}
          </span>
          <span className="active-now-event-title">Vinyl After Dark</span>
          <span className="active-now-event-seller">Needle &amp; Groove</span>
          <span className="active-now-event-meta">128 watching</span>
        </span>
        <span className="active-now-current" title="Currently watching" aria-hidden="true">✓</span>
        <span className="active-now-sr-only">Currently watching</span>
      </a>
    </li>
  );
}

function ScheduledEventRow() {
  return (
    <li>
      <a
        className="active-now-event-row"
        href="/?tab=buyer&event=studio-ceramics"
        aria-label="Studio Ceramics by Good Clay. Starts in 14 minutes 32 seconds at 9:00 PM."
      >
        <PreviewThumbnail label="S" />
        <span className="active-now-event-copy">
          <span className="active-now-event-title">Studio Ceramics</span>
          <span className="active-now-event-seller">Good Clay</span>
          <span className="active-now-event-meta is-scheduled">Starts in 14m 32s · 9:00 PM</span>
        </span>
      </a>
    </li>
  );
}

function ChannelGuidePreview({ option }: { option: ComparisonOption }) {
  return (
    <aside className="active-now-guide" aria-label={`${option.title} Channel Guide preview`}>
      <header className="active-now-guide-header">
        <p>What&rsquo;s on</p>
        <h3>Every live room</h3>
      </header>

      <div className="active-now-guide-body">
        <section aria-labelledby={`${option.id}-live-heading`}>
          <h4 id={`${option.id}-live-heading`} className="active-now-group-label is-live">
            <span className="active-now-live-dot" aria-hidden="true" />
            Live now
            <span>1</span>
          </h4>
          <ul className="active-now-event-list">
            <LiveEventRow option={option} />
          </ul>
        </section>

        <section aria-labelledby={`${option.id}-up-next-heading`}>
          <h4 id={`${option.id}-up-next-heading`} className="active-now-group-label is-scheduled">
            Up next
            <span>1</span>
          </h4>
          <ul className="active-now-event-list">
            <ScheduledEventRow />
          </ul>
        </section>
      </div>
    </aside>
  );
}

export function ActiveNowComparison() {
  return (
    <main className="active-now-page">
      <header className="active-now-page-header">
        <div className="active-now-page-nav">
          <a href="/?tab=buyer">← Back to SideStage</a>
          <span>Channel Guide study</span>
        </div>
        <p className="active-now-page-eyebrow">Live event visibility</p>
        <h1>How should &ldquo;live&rdquo; feel?</h1>
        <p className="active-now-page-intro">
          Three treatments using the same room, seller, viewer count, and upcoming event.
          The red treatment means <strong>the event is live</strong>; the check means
          <strong> you are currently watching it</strong>.
        </p>
        <div className="active-now-state-key" aria-label="Preview state key">
          <span><i className="active-now-live-dot" aria-hidden="true" /> Event is live</span>
          <span><i className="active-now-key-check" aria-hidden="true">✓</i> Current room</span>
          <span><i className="active-now-key-scheduled" aria-hidden="true" /> Scheduled countdown</span>
        </div>
      </header>

      <section className="active-now-options" aria-label="Active-now design options">
        {OPTIONS.map((option) => (
          <article
            className={`active-now-option-card${option.recommended ? ' is-recommended' : ''}`}
            data-active-now-option={option.id}
            key={option.id}
          >
            <header className="active-now-option-header">
              <div className="active-now-option-kicker">
                <span>{option.number}</span>
                {option.recommended ? <strong>Recommended</strong> : null}
              </div>
              <h2>{option.title}</h2>
              <p>{option.summary}</p>
            </header>

            <ChannelGuidePreview option={option} />

            <dl className="active-now-option-notes">
              <div>
                <dt>Visual weight</dt>
                <dd>{option.strength}</dd>
              </div>
              <div>
                <dt>Best for</dt>
                <dd>{option.bestFor}</dd>
              </div>
            </dl>
          </article>
        ))}
      </section>
    </main>
  );
}

export default ActiveNowComparison;
