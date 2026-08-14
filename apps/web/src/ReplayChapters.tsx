import { useSyncQuery } from '@papercusp/sync';
import type { RefObject } from 'react';

export interface ReplayChapter {
  id: string;
  productId: string;
  productTitle: string;
  startMs: number;
  endMs?: number;
  previewText: string;
}

export function formatReplayTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function seekToReplayChapter(video: HTMLVideoElement | null, chapter: ReplayChapter): boolean {
  if (!video) return false;
  video.currentTime = chapter.startMs / 1_000;
  void video.play().catch(() => undefined);
  return true;
}

export function ReplayChapterList({
  chapters,
  videoRef,
}: {
  chapters: readonly ReplayChapter[];
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  if (chapters.length === 0) return null;
  return (
    <section className="replay-chapters" aria-labelledby="replay-chapters-title">
      <div className="replay-chapters-heading">
        <div>
          <p className="eyebrow">Shop the replay</p>
          <h3 id="replay-chapters-title">Jump to a product moment</h3>
        </div>
        <span>{chapters.length} {chapters.length === 1 ? 'chapter' : 'chapters'}</span>
      </div>
      <ol>
        {chapters.map((chapter) => (
          <li key={chapter.id}>
            <button type="button" onClick={() => seekToReplayChapter(videoRef.current, chapter)}>
              <span className="replay-chapter-time">{formatReplayTime(chapter.startMs)}</span>
              <span>
                <strong>{chapter.productTitle}</strong>
                <small>{chapter.previewText}</small>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReplayChaptersSurface({
  eventId,
  videoRef,
}: {
  eventId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
}) {
  const query = useSyncQuery<ReplayChapter>({
    queryName: 'event.replay.chapters',
    args: { eventId },
    pollIntervalMs: 10_000,
  });
  return <ReplayChapterList chapters={query.data ?? []} videoRef={videoRef} />;
}

export function ReplayChapters({
  eventId,
  videoRef,
  apiBaseUrl: _apiBaseUrl,
}: {
  eventId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  apiBaseUrl?: string;
}) {
  return <ReplayChaptersSurface eventId={eventId} videoRef={videoRef} />;
}
