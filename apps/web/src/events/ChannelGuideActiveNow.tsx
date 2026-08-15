import type { GuideEvent } from './api';
import './channel-guide-active-now.css';

export const CHANNEL_GUIDE_ACTIVE_NOW_LABEL = 'Live now';

/**
 * Keep the live-row hook in one place so production integration cannot
 * accidentally apply the red treatment to scheduled or replay rows.
 */
export function channelGuideActiveNowRowClass(status: GuideEvent['status']): string {
  return status === 'live' ? ' is-active-now' : '';
}

export interface ChannelGuideActiveNowProps {
  watchingLabel: string;
}

/**
 * The approved Signal rail status cluster for a live Channel Guide row.
 *
 * The visible label carries the state without relying on red alone. Viewer
 * copy remains a separate value, just as the current-room check remains a
 * separate control owned by ChannelGuide.
 */
export function ChannelGuideActiveNow({ watchingLabel }: ChannelGuideActiveNowProps) {
  return (
    <span className="channel-guide-active-now">
      <span className="channel-guide-active-now-badge">
        <span className="channel-guide-active-now-dot" aria-hidden="true" />
        {CHANNEL_GUIDE_ACTIVE_NOW_LABEL}
      </span>
      <span className="channel-guide-active-now-watchers">{watchingLabel}</span>
    </span>
  );
}

export default ChannelGuideActiveNow;
