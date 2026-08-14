/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  findTranscriptProductMention,
  resolveTranscriptStageIntent,
  useLiveTranscript,
  type LiveTranscriptController,
  type TranscriptProductOption,
} from './use-live-transcript';
import type {
  ErrorListener,
  SegmentListener,
  StateListener,
  TranscriptSegment,
  TranscriptionSession,
  TranscriptionState,
} from './transcription';

const PRODUCTS: readonly TranscriptProductOption[] = [
  { id: 'hoodie', label: 'Linen hoodie', aliases: ['hoodie'] },
  { id: 'mug', label: 'Stoneware mug', price: '$24.00', aliases: ['mug'] },
];

describe('transcript product mentions', () => {
  it('matches labels and aliases without being case-sensitive', () => {
    expect(findTranscriptProductMention('Could you show me that STONEWARE mug?', PRODUCTS)?.id).toBe('mug');
    expect(findTranscriptProductMention('The hoodie looks great on camera.', PRODUCTS)?.id).toBe('hoodie');
  });

  it('does not stage a product until a pending mention is confirmed', () => {
    expect(resolveTranscriptStageIntent('Show the stoneware mug', PRODUCTS, null)).toEqual({
      kind: 'propose',
      product: PRODUCTS[1],
    });
    expect(resolveTranscriptStageIntent('yes', PRODUCTS, null)).toBeNull();
    expect(resolveTranscriptStageIntent('stage it', PRODUCTS, PRODUCTS[1])).toEqual({
      kind: 'confirm',
      product: PRODUCTS[1],
    });
  });
});

class FakeTranscriptionSession implements TranscriptionSession {
  readonly provider = 'web-speech' as const;
  state: TranscriptionState = 'idle';
  private readonly segmentListeners = new Set<SegmentListener>();
  private readonly stateListeners = new Set<StateListener>();
  private readonly errorListeners = new Set<ErrorListener>();

  readonly start = vi.fn(async () => {
    this.setState('listening');
  });

  readonly stop = vi.fn(async () => {
    this.setState('stopped');
  });

  onSegment(listener: SegmentListener) {
    this.segmentListeners.add(listener);
    return () => { this.segmentListeners.delete(listener); };
  }

  onState(listener: StateListener) {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  onError(listener: ErrorListener) {
    this.errorListeners.add(listener);
    return () => { this.errorListeners.delete(listener); };
  }

  emit(segment: TranscriptSegment) {
    for (const listener of this.segmentListeners) listener(segment);
  }

  private setState(state: TranscriptionState) {
    this.state = state;
    for (const listener of this.stateListeners) listener(state);
  }
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

describe('useLiveTranscript', () => {
  it('starts and stops the injected transcription session with the publisher lifecycle', async () => {
    const session = new FakeTranscriptionSession();
    let controller: LiveTranscriptController | null = null;

    function Harness({ active }: { active: boolean }) {
      controller = useLiveTranscript({
        session,
        active,
        products: PRODUCTS,
        activeProductId: null,
        onActiveProductChange: () => undefined,
      });
      return <output>{controller.state}</output>;
    }

    await act(async () => root.render(<Harness active={false} />));
    expect(session.stop).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('stopped');

    await act(async () => root.render(<Harness active />));
    expect(session.start).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('listening');

    await act(async () => root.render(<Harness active={false} />));
    expect(session.stop).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe('stopped');
  });

  it('keeps interim/final history and stages a mentioned product only after confirmation', async () => {
    const session = new FakeTranscriptionSession();
    const onActiveProductChange = vi.fn();
    const onFinalSegment = vi.fn();
    let controller: LiveTranscriptController | null = null;
    const currentController = () => {
      if (!controller) throw new Error('Expected the transcript controller to be mounted.');
      return controller;
    };

    function Harness() {
      controller = useLiveTranscript({
        session,
        active: true,
        products: PRODUCTS,
        activeProductId: null,
        onActiveProductChange,
        onFinalSegment,
      });
      return <output>{controller.interim || controller.suggestedProduct?.label || ''}</output>;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => session.emit({
      id: 'interim-1',
      text: 'Show the stoneware',
      isFinal: false,
      provider: 'web-speech',
      receivedAt: 1,
    }));
    expect(currentController().interim).toBe('Show the stoneware');

    const mention: TranscriptSegment = {
      id: 'final-1',
      text: 'Show the stoneware mug',
      isFinal: true,
      provider: 'web-speech',
      receivedAt: 2,
      startMs: 2_000,
    };
    await act(async () => session.emit(mention));
    expect(currentController().interim).toBe('');
    expect(currentController().finalSegments).toEqual([mention]);
    expect(currentController().suggestedProduct?.id).toBe('mug');
    expect(onActiveProductChange).not.toHaveBeenCalled();
    expect(onFinalSegment).toHaveBeenCalledWith(mention);

    const confirmation: TranscriptSegment = {
      id: 'final-2',
      text: 'yes',
      isFinal: true,
      provider: 'web-speech',
      receivedAt: 3,
    };
    await act(async () => session.emit(confirmation));
    expect(onActiveProductChange).toHaveBeenCalledWith('mug');
    expect(currentController().suggestedProduct).toBeNull();
    expect(currentController().finalSegments).toEqual([mention, confirmation]);
    expect(onFinalSegment).toHaveBeenLastCalledWith(confirmation);
  });
});
