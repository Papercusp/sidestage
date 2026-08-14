import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { CopilotPanel } from './CopilotPanel';
import type { SellerDockPanelContextValue } from './seller-dock-panel-props';
import { RunOfShowPanel } from './seller/RunOfShowPanel';
import { StageStatusPanel } from './seller/StageStatusPanel';

export const STUDIO_MOBILE_MEDIA_QUERY = '(max-width: 760px)';

export const STUDIO_MOBILE_MODES = [
  { id: 'stage', label: 'Stage' },
  { id: 'lineup', label: 'Lineup' },
  { id: 'copilot', label: 'Copilot' },
] as const;

export type StudioMobileMode = (typeof STUDIO_MOBILE_MODES)[number]['id'];

export function nextStudioMobileMode(
  current: StudioMobileMode,
  key: string,
): StudioMobileMode | null {
  const index = STUDIO_MOBILE_MODES.findIndex(({ id }) => id === current);
  if (key === 'Home') return STUDIO_MOBILE_MODES[0].id;
  if (key === 'End') return STUDIO_MOBILE_MODES.at(-1)!.id;
  if (key === 'ArrowRight') return STUDIO_MOBILE_MODES[(index + 1) % STUDIO_MOBILE_MODES.length].id;
  if (key === 'ArrowLeft') return STUDIO_MOBILE_MODES[(index - 1 + STUDIO_MOBILE_MODES.length) % STUDIO_MOBILE_MODES.length].id;
  return null;
}

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
  const tabsRef = useRef<HTMLElement>(null);

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const next = nextStudioMobileMode(mode, event.key);
    if (!next) return;
    event.preventDefault();
    setMode(next);
    tabsRef.current
      ?.querySelector<HTMLButtonElement>(`#seller-mobile-tab-${next}`)
      ?.focus();
  };

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
        {mode === 'copilot' ? <CopilotPanel {...panels.copilot} /> : null}
      </section>

      <nav ref={tabsRef} className="seller-mobile-tabs" aria-label="Studio mobile panels" role="tablist">
        {STUDIO_MOBILE_MODES.map(({ id, label }) => (
          <button
            key={id}
            id={`seller-mobile-tab-${id}`}
            type="button"
            role="tab"
            aria-controls={`seller-mobile-panel-${id}`}
            aria-selected={mode === id}
            tabIndex={mode === id ? 0 : -1}
            onClick={() => setMode(id)}
            onKeyDown={onTabKeyDown}
          >
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}
