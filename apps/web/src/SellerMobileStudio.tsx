import { useEffect, useState } from 'react';
import { CopilotPanel } from './CopilotPanel';
import { EventChat } from './EventChat';
import type { SellerDockPanelContextValue } from './seller-dock-panel-props';
import { RunOfShowPanel } from './seller/RunOfShowPanel';
import { StageStatusPanel } from './seller/StageStatusPanel';

export const STUDIO_MOBILE_MEDIA_QUERY = '(max-width: 760px)';

export const STUDIO_MOBILE_MODES = [
  { id: 'stage', label: 'Stage' },
  { id: 'lineup', label: 'Lineup' },
  { id: 'chat', label: 'Chat' },
  { id: 'copilot', label: 'Copilot' },
] as const;

export type StudioMobileMode = (typeof STUDIO_MOBILE_MODES)[number]['id'];

type MatchMedia = (query: string) => Pick<MediaQueryList, 'matches'>;

/** Pure seam so the responsive route is covered without depending on jsdom layout. */
export function isMobileStudioViewport(matchMedia?: MatchMedia): boolean {
  const resolve = matchMedia
    ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia.bind(window)
      : undefined);
  return resolve?.(STUDIO_MOBILE_MEDIA_QUERY).matches ?? false;
}

/**
 * Dockview is a desktop workbench. Mount exactly one responsive surface at a
 * time so mobile does not duplicate chat subscriptions, transcript sockets,
 * or camera state behind a `display:none` desktop dock.
 */
export function useMobileStudioViewport(): boolean {
  const [mobile, setMobile] = useState(() => isMobileStudioViewport());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(STUDIO_MOBILE_MEDIA_QUERY);
    const onChange = (event: MediaQueryListEvent) => setMobile(event.matches);
    setMobile(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return mobile;
}

export function SellerMobileStudio({ panels }: { panels: SellerDockPanelContextValue }) {
  const [mode, setMode] = useState<StudioMobileMode>('stage');

  return (
    <div className="seller-mobile-studio">
      <section
        className="seller-mobile-panel"
        role="tabpanel"
        id={`seller-mobile-panel-${mode}`}
        aria-labelledby={`seller-mobile-tab-${mode}`}
      >
        {mode === 'stage' ? <StageStatusPanel {...panels['stage-status']} /> : null}
        {mode === 'lineup' ? <RunOfShowPanel {...panels['run-of-show']} /> : null}
        {mode === 'chat' ? <EventChat {...panels['event-chat']} /> : null}
        {mode === 'copilot' ? <CopilotPanel {...panels.copilot} /> : null}
      </section>

      <nav className="seller-mobile-tabs" aria-label="Studio mobile panels" role="tablist">
        {STUDIO_MOBILE_MODES.map(({ id, label }) => (
          <button
            key={id}
            id={`seller-mobile-tab-${id}`}
            type="button"
            role="tab"
            aria-controls={`seller-mobile-panel-${id}`}
            aria-selected={mode === id}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
