/** @vitest-environment jsdom */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveTranscriptOverlay, liveTranscriptStateLabel } from './LiveTranscriptOverlay';
import type { LiveTranscriptController } from './use-live-transcript';

function readWebStyle(name: string): string {
  const workspacePath = resolve(process.cwd(), 'src', name);
  const rootPath = resolve(process.cwd(), 'apps/web/src', name);
  return readFileSync(existsSync(workspacePath) ? workspacePath : rootPath, 'utf8');
}

const overlayCss = readWebStyle('live-transcript-overlay.css');
const engagementCss = readWebStyle('video-engagement-overlay.css');

function transcriptFixture(overrides: Partial<LiveTranscriptController> = {}): LiveTranscriptController {
  return {
    provider: 'web-speech',
    state: 'idle',
    finalSegments: [],
    interim: '',
    error: null,
    activeProduct: null,
    suggestedProduct: null,
    stageProduct: () => undefined,
    dismissSuggestion: () => undefined,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

describe('LiveTranscriptOverlay', () => {
  it('composes transcript and chat under one responsive video overlay root', () => {
    expect(overlayCss).toMatch(/\.seller-stream-preview\s*\{[^}]*container-type:\s*inline-size;/);
    expect(overlayCss).toMatch(/\.live-transcript-history\s*\{[^}]*max-height:\s*4\.5rem;/);
    expect(overlayCss).not.toMatch(/\.live-transcript-history\s*\{[^}]*max-height:[^;}]*%/);
    expect(engagementCss).toMatch(/\.video-engagement-overlay\s*\{[^}]*position:\s*absolute;[^}]*right:\s*\.75rem;[^}]*bottom:\s*\.75rem;[^}]*left:\s*\.75rem;/s);
    expect(engagementCss).toMatch(/\.video-engagement-overlay > \.live-transcript-overlay\s*\{[^}]*position:\s*static;[^}]*width:\s*100%;/s);
    expect(engagementCss).toMatch(/\.video-engagement-chat-panel\s*\{[^}]*height:\s*clamp\(8rem, 28vh, 15rem\);/s);
    expect(engagementCss).toMatch(/@container \(max-width: 32rem\) \{[\s\S]*?\.seller-stream-preview > \.stream-video \{[^}]*min-height:\s*27rem;[^}]*aspect-ratio:\s*auto;/);
  });

  it('keeps transcript controls responsive without reserving video height for detached buyer chat', () => {
    expect(engagementCss).toMatch(/\.buyer-player-card\s*\{[^}]*container-type:\s*inline-size;/);
    expect(engagementCss).toMatch(/\.buyer-player-card > \.buyer-player-overlay\s*\{[^}]*top:\s*\.75rem;[^}]*bottom:\s*auto;/s);
    expect(engagementCss).not.toContain('.buyer-stage-grid .buyer-player-card > .buyer-player');
    expect(engagementCss).toMatch(/@container \(max-width: 32rem\) \{[\s\S]*?\.buyer-player-card > \.buyer-player-overlay\s*\{[^}]*left:\s*\.5rem;/);
    expect(overlayCss).toMatch(/@container \(max-width: 18rem\) \{[\s\S]*?\.live-transcript-toolbar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(overlayCss).toMatch(/\.live-transcript-history-toggle,\s*\.live-transcript-toolbar > \.video-engagement-chat-toggle\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;/s);
  });

  it('uses explicit, user-facing labels for every transcription state', () => {
    expect(liveTranscriptStateLabel('idle')).toBe('Captions start with the event');
    expect(liveTranscriptStateLabel('connecting')).toBe('Starting captions…');
    expect(liveTranscriptStateLabel('listening')).toBe('Captions live');
    expect(liveTranscriptStateLabel('stopped')).toBe('Captions start with the event');
    expect(liveTranscriptStateLabel('error')).toBe('Captions need attention');
  });

  it('exposes caption history, active product, mention actions, and errors accessibly', async () => {
    const stageProduct = vi.fn();
    const dismissSuggestion = vi.fn();
    const transcript = transcriptFixture({
      state: 'listening',
      finalSegments: [{
        id: 'segment-1',
        text: 'The stoneware mug is dishwasher safe.',
        isFinal: true,
        provider: 'web-speech',
        receivedAt: 1,
        startMs: 2_000,
      }],
      activeProduct: { id: 'hoodie', label: 'Linen hoodie' },
      suggestedProduct: { id: 'mug', label: 'Stoneware mug', price: '$24.00' },
      error: 'Microphone permission was denied.',
      stageProduct,
      dismissSuggestion,
    });

    await act(async () => root.render(<LiveTranscriptOverlay transcript={transcript} />));

    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain('dishwasher safe');
    expect(container.textContent).toContain('Captions live');
    expect(container.textContent).toContain('On stage: Linen hoodie');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Microphone permission was denied.');

    const stageButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('Make Stoneware mug active'));
    await act(async () => stageButton?.click());
    expect(stageProduct).toHaveBeenCalledWith('mug');

    const dismissButton = container.querySelector<HTMLButtonElement>('[aria-label="Dismiss product mention"]');
    await act(async () => dismissButton?.click());
    expect(dismissSuggestion).toHaveBeenCalledTimes(1);

    const historyButton = Array.from(container.querySelectorAll('button'))
      .find((button) => button.textContent === 'Transcript');
    expect(historyButton?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => historyButton?.click());

    const history = container.querySelector<HTMLElement>('[role="region"][aria-label="Transcript history"]');
    expect(history).not.toBeNull();
    expect(history?.tabIndex).toBe(0);
    expect(history?.textContent).toContain('0:02');
    expect(history?.textContent).toContain('The stoneware mug is dishwasher safe.');
    expect(container.querySelector('[aria-expanded="true"]')?.textContent).toBe('Close transcript');
  });
});
