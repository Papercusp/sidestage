import { createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  formatReplayTime,
  ReplayChapterList,
  seekToReplayChapter,
  type ReplayChapter,
} from './ReplayChapters';

const CHAPTER: ReplayChapter = {
  id: 'chapter-1',
  productId: 'aurora-cup',
  productTitle: 'Aurora cup',
  startMs: 83_000,
  endMs: 98_000,
  previewText: 'See the hand-painted detail up close.',
};

describe('ReplayChapters', () => {
  it('formats chapter offsets for the replay timeline', () => {
    expect(formatReplayTime(83_000)).toBe('1:23');
  });

  it('renders product identity, timestamp, and transcript preview', () => {
    const html = renderToStaticMarkup(
      <ReplayChapterList chapters={[CHAPTER]} videoRef={createRef<HTMLVideoElement>()} />,
    );
    expect(html).toContain('Jump to a product moment');
    expect(html).toContain('1:23');
    expect(html).toContain('Aurora cup');
    expect(html).toContain('See the hand-painted detail up close.');
  });

  it('seeks and resumes the existing player', () => {
    const play = vi.fn().mockResolvedValue(undefined);
    const video = { currentTime: 0, play } as unknown as HTMLVideoElement;
    expect(seekToReplayChapter(video, CHAPTER)).toBe(true);
    expect(video.currentTime).toBe(83);
    expect(play).toHaveBeenCalledOnce();
  });
});
