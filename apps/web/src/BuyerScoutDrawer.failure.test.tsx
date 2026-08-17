/** @vitest-environment jsdom */

/**
 * WI-39716 — the buyer Scout composer must never lock forever.
 *
 * Filed repro: Watch → Ask Scout → send a question the backend rejects. The
 * drawer showed "Scout is checking SideStage" and DISABLED the textbox + Send
 * button; four minutes later it was still locked, unrecoverable without a page
 * reload. The turn never settled, so ScoutChat's `finally { setLoading(false) }`
 * never ran.
 *
 * These drive the real shipped stack — SIDE_STAGE_SCOUT_STRINGS and
 * createSideStageScoutTransport through @papercusp/scout-chat and
 * resilientPostStream — with only `fetch` faked, so they fail if the deadline,
 * the plumbing, or the buyer-facing string regresses at ANY layer.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScoutChat } from '@papercusp/scout-chat';
import { SIDE_STAGE_SCOUT_STRINGS } from './BuyerScoutDrawer';
import { createSideStageScoutTransport } from './scout-transport';

const IDLE_MS = 40;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // jsdom does not implement scrollIntoView, which ScoutChat calls on every
  // transcript update. Unrelated to what these tests assert.
  Element.prototype.scrollIntoView = () => {};
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.sessionStorage.clear();
});

/** A response that is accepted and then never says anything again. */
function silentResponse(signal: AbortSignal): Response {
  return {
    ok: true,
    headers: { get: () => null },
    body: new ReadableStream<Uint8Array>({
      start(c) {
        // Real fetch errors the body stream when the request is aborted; the
        // fake must too, or nothing can unstick the read.
        if (signal.aborted) c.error(new Error('aborted'));
        else signal.addEventListener('abort', () => c.error(new Error('aborted')), { once: true });
      },
    }),
  } as unknown as Response;
}

function renderScout(fetchImpl: typeof fetch): void {
  const transport = createSideStageScoutTransport({
    buyerId: 'audit-buyer-a',
    idleTimeoutMs: IDLE_MS,
    fetchImpl,
    cookieDocument: { cookie: '' },
  });
  act(() => {
    root.render(
      <ScoutChat
        transport={transport}
        strings={SIDE_STAGE_SCOUT_STRINGS}
        emptyState={(send) => (
          <button type="button" id="ask" onClick={() => send('how many gallons does the harbor kettle hold?')}>
            ask
          </button>
        )}
      />,
    );
  });
}

const composer = () => container.querySelector('textarea') as HTMLTextAreaElement;

async function settle(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('composer never recovered');
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
}

describe('buyer Scout failure handling (WI-39716)', () => {
  it('hands the composer back when the server accepts the turn then goes silent', async () => {
    renderScout(((_url: string, init: RequestInit) =>
      Promise.resolve(silentResponse(init.signal as AbortSignal))) as unknown as typeof fetch);

    await act(async () => { container.querySelector<HTMLButtonElement>('#ask')!.click(); });
    // The in-flight turn legitimately locks the composer…
    expect(composer().disabled).toBe(true);

    // …but the idle deadline must give it back. Before the fix this waited forever.
    await settle(() => composer().disabled === false);
    expect(composer().disabled).toBe(false);
    expect(container.textContent).toContain('ask the seller');
    // The raw failure never reaches the buyer.
    expect(container.textContent).not.toContain('SSE stream idle');
  });

  it('surfaces a 400 as the same labelled fallback instead of a raw HTTP status', async () => {
    renderScout((() => Promise.resolve({
      ok: false,
      status: 400,
      headers: { get: () => null },
      body: null,
    } as unknown as Response)) as unknown as typeof fetch);

    await act(async () => { container.querySelector<HTMLButtonElement>('#ask')!.click(); });
    await settle(() => composer().disabled === false);

    expect(container.textContent).toContain('ask the seller');
    expect(container.textContent).not.toContain('HTTP 400');
  });
});
