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

  it('carries the sibling colourways through to the surface instead of only the best guess', async () => {
    // Four rows of ONE product: the seller who says "the arc table lamp" has
    // not named a colourway, so the controller must hand the surface all four.
    const COLOURWAYS: readonly TranscriptProductOption[] = [
      { id: 'lamp-v1', groupKey: 'lamp', label: 'Arc Table Lamp', color: 'Sage' },
      { id: 'lamp-v2', groupKey: 'lamp', label: 'Arc Table Lamp', color: 'Sand' },
      { id: 'lamp-v3', groupKey: 'lamp', label: 'Arc Table Lamp', color: 'Plum' },
      { id: 'lamp-v4', groupKey: 'lamp', label: 'Arc Table Lamp', color: 'Clay' },
      { id: 'mug', groupKey: 'mug', label: 'Stoneware mug', aliases: ['mug'] },
    ];
    const session = new FakeTranscriptionSession();
    let controller: LiveTranscriptController | null = null;
    const currentController = () => {
      if (!controller) throw new Error('Expected the transcript controller to be mounted.');
      return controller;
    };

    function Harness() {
      controller = useLiveTranscript({
        session,
        active: true,
        products: COLOURWAYS,
        activeProductId: null,
        onActiveProductChange: vi.fn(),
      });
      return <output>{controller.suggestedProduct?.label ?? ''}</output>;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => session.emit({
      id: 'final-1',
      text: "Now let's switch to the arc table lamp.",
      isFinal: true,
      provider: 'web-speech',
      receivedAt: 1,
    }));

    expect(currentController().suggestedProduct?.label).toBe('Arc Table Lamp');
    expect(currentController().suggestedVariantChoices?.map((choice) => choice.color))
      .toEqual(['Sage', 'Sand', 'Plum', 'Clay']);
  });

  it('leaves the colourway list empty for a single-variant product', async () => {
    // No colourway question to ask, so the surface must get an empty list
    // rather than a one-element picker with nothing to pick.
    const session = new FakeTranscriptionSession();
    let controller: LiveTranscriptController | null = null;

    function Harness() {
      controller = useLiveTranscript({
        session,
        active: true,
        products: PRODUCTS,
        activeProductId: null,
        onActiveProductChange: vi.fn(),
      });
      return <output>{controller.suggestedProduct?.label ?? ''}</output>;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => session.emit({
      id: 'final-1',
      text: 'Show the stoneware mug',
      isFinal: true,
      provider: 'web-speech',
      receivedAt: 1,
    }));

    expect(controller!.suggestedProduct?.id).toBe('mug');
    expect(controller!.suggestedVariantChoices).toEqual([]);
  });

  it('suppresses the active product and keeps a dismissed alternative on cooldown', async () => {
    const session = new FakeTranscriptionSession();
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
        activeProductId: 'hoodie',
        onActiveProductChange: () => undefined,
      });
      return <output>{controller.suggestedProduct?.label ?? ''}</output>;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => session.emit({
      id: 'active-mention', text: 'The linen hoodie has a relaxed fit.', isFinal: true, provider: 'web-speech', receivedAt: 1,
    }));
    expect(currentController().suggestedProduct).toBeNull();

    await act(async () => session.emit({
      id: 'other-mention', text: 'Now let us look at the stoneware mug.', isFinal: true, provider: 'web-speech', receivedAt: 2,
    }));
    expect(currentController().suggestedProduct?.id).toBe('mug');
    await act(async () => currentController().dismissSuggestion());
    await act(async () => session.emit({
      id: 'repeat', text: 'The stoneware mug is dishwasher safe.', isFinal: true, provider: 'web-speech', receivedAt: 3,
    }));
    expect(currentController().suggestedProduct).toBeNull();
  });

  it('uses semantic fallback for unresolved context and ignores stale results after an active-product change', async () => {
    const session = new FakeTranscriptionSession();
    let controller: LiveTranscriptController | null = null;
    const currentController = () => {
      if (!controller) throw new Error('Expected the transcript controller to be mounted.');
      return controller;
    };
    let resolveClassification: ((value: {
      decision: 'different'; productId: string; confidence: number; evidenceSegmentIds: string[]; requestSequence: number;
    }) => void) | undefined;
    const classifyProductFocus = vi.fn((input: { requestSequence: number }) => new Promise<{
      decision: 'different'; productId: string; confidence: number; evidenceSegmentIds: string[]; requestSequence: number;
    }>((resolve) => {
      resolveClassification = (value) => resolve({ ...value, requestSequence: input.requestSequence });
    }));

    function Harness({ activeProductId }: { activeProductId: string }) {
      controller = useLiveTranscript({
        session,
        active: true,
        products: PRODUCTS,
        activeProductId,
        onActiveProductChange: () => undefined,
        classifyProductFocus,
      });
      return <output>{controller.suggestedProduct?.label ?? ''}</output>;
    }

    await act(async () => root.render(<Harness activeProductId="hoodie" />));
    await act(async () => session.emit({
      id: 'semantic-1',
      text: 'Moving on now, this one has a glazed finish and a comfortable handle.',
      isFinal: true,
      provider: 'web-speech',
      receivedAt: 1,
    }));
    expect(classifyProductFocus).toHaveBeenCalledOnce();

    await act(async () => root.render(<Harness activeProductId="mug" />));
    await act(async () => resolveClassification?.({
      decision: 'different', productId: 'mug', confidence: 0.96, evidenceSegmentIds: ['semantic-1'], requestSequence: 0,
    }));
    expect(currentController().suggestedProduct).toBeNull();
  });

  it('surfaces a catalog-validated semantic different-product result', async () => {
    const session = new FakeTranscriptionSession();
    let controller: LiveTranscriptController | null = null;
    const currentController = () => {
      if (!controller) throw new Error('Expected the transcript controller to be mounted.');
      return controller;
    };
    const classifyProductFocus = vi.fn(async (input: { requestSequence: number }) => ({
      decision: 'different' as const,
      productId: 'mug',
      confidence: 0.95,
      evidenceSegmentIds: ['semantic-1'],
      requestSequence: input.requestSequence,
    }));

    function Harness() {
      controller = useLiveTranscript({
        session,
        active: true,
        products: PRODUCTS,
        activeProductId: 'hoodie',
        onActiveProductChange: () => undefined,
        classifyProductFocus,
      });
      return <output>{controller.suggestedProduct?.label ?? ''}</output>;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => {
      session.emit({
        id: 'semantic-1',
        text: 'Moving on now, this one has a glazed finish and a comfortable handle.',
        isFinal: true,
        provider: 'web-speech',
        receivedAt: 1,
      });
      await Promise.resolve();
    });
    expect(currentController().suggestedProduct?.id).toBe('mug');
    expect(currentController().suggestionConfidence).toBe(0.95);
  });

  /*
   * WI-39726: a start that cannot run belongs in the controller's `error`, not
   * in an unhandled rejection. The Studio renders this string, so a refusal has
   * to arrive as recoverable UI state rather than a console-only browser throw.
   */
  it('surfaces a refused start as recoverable controller error state', async () => {
    const session = new FakeTranscriptionSession();
    const refusal = 'The microphone for this event is no longer live, so captions could not start. Start the event again to resume transcription.';
    session.start.mockRejectedValueOnce(new Error(refusal));
    const unhandled: unknown[] = [];
    const onUnhandled = (event: PromiseRejectionEvent) => { unhandled.push(event.reason); };
    window.addEventListener('unhandledrejection', onUnhandled);
    let controller: LiveTranscriptController | null = null;

    function Harness() {
      controller = useLiveTranscript({
        session,
        active: true,
        products: PRODUCTS,
        activeProductId: null,
        onActiveProductChange: () => undefined,
      });
      return <output>{controller.error ?? ''}</output>;
    }

    await act(async () => root.render(<Harness />));
    await act(async () => { await Promise.resolve(); });

    expect(container.textContent).toBe(refusal);
    expect(container.textContent).not.toContain('Failed to execute');
    expect(unhandled).toEqual([]);
    window.removeEventListener('unhandledrejection', onUnhandled);
    expect(controller).not.toBeNull();
  });
});
