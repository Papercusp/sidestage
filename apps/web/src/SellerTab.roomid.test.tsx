/** @vitest-environment jsdom */

/**
 * The Studio must not fetch a room the seller has not finished typing
 * (WI-39272).
 *
 * The reported defect: the Event room id field was controlled directly by the
 * pinned identity, and a pin outranks the directory, so every keystroke became
 * the room every board resolved to. Replacing the id with whitespace issued
 * GET /events/%20/config and GET /actions/events/%20/items — both 400 — before
 * Start had validated anything, and the 10s stage-items poll repeated it.
 *
 * These tests drive the REAL input through the REAL handler and assert on the
 * two things that must both hold, because either alone is satisfied by a
 * different bug:
 *
 *   - an invalid draft moves NO board (the fix), and
 *   - Start still REFUSES that draft (what a careless fix breaks — dropping the
 *     invalid text would make Start go live in the last valid room silently,
 *     which is worse than the 400s).
 *
 * `useStreamSession` and `createEventRoom` are deliberately NOT mocked: the
 * rejection path is the real one, so this cannot pass against a stub that
 * merely agrees with it.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  queries: [] as Array<{ queryName: string; args: Record<string, unknown> }>,
  panels: [] as Array<Record<string, { eventId?: string } & Record<string, unknown>>>,
}));

vi.mock('@papercusp/sync', () => ({
  DEMO_PRINCIPAL_HEADER: 'x-demo-principal',
  SyncProvider: ({ children }: { children?: unknown }) => children,
  useSyncPrincipal: () => 'demo-seller',
  useSyncQuery: (options: { queryName: string; args?: Record<string, unknown> }) => {
    captured.queries.push({ queryName: options.queryName, args: options.args ?? {} });
    return { data: [], loading: false, error: null };
  },
  // events.guide / events.mine are REST-pinned (WI-39855) and so reach the
  // boards through this hook instead. Captured in the SAME list on purpose:
  // what this file asserts is which room ids the boards asked for, which must
  // not change with the transport a given name is pinned to.
  useRestSyncQuery: (options: { queryName: string; args?: Record<string, unknown> }) => {
    captured.queries.push({ queryName: options.queryName, args: options.args ?? {} });
    return { data: [], loading: false, error: null };
  },
  useSyncMutate: (_name: string, fallback?: (input: unknown) => Promise<unknown>) => (
    (input: unknown) => (fallback ? fallback(input) : Promise.resolve(undefined))
  ),
}));

/** The chat transport is not under test, and loading it would open sockets. */
vi.mock('./EventChat', () => ({
  EventChat: () => null,
  resolveApiOrigin: (base?: string) => base ?? 'http://localhost:8787',
}));

/**
 * Stand in for the dock, but render the REAL stage-status panel from the props
 * SellerTab hands it. That keeps the seam honest in both directions: the field
 * and its handler are the shipping ones, and the props every other board would
 * have fetched with are captured exactly as the dock would receive them.
 */
vi.mock('./SellerDock', async () => {
  const { createElement: create } = await import('react');
  const { StageStatusPanel } = await import('./seller/StageStatusPanel');
  return {
    SellerDock: ({ panels }: { panels: Record<string, Record<string, unknown>> }) => {
      captured.panels.push(panels as never);
      return create(StageStatusPanel, panels['stage-status'] as never);
    },
  };
});

import { SellerTab } from './SellerTab';
import { normalizedEventId } from './event-identity';

/** Every panel prop that becomes a request path segment. */
const DATA_PANELS = ['event-manager', 'inventory', 'on-deck', 'run-of-show', 'copilot', 'event-chat'] as const;

type ActEnv = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderStudio(): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const created = createRoot(host);
  act(() => {
    created.render(createElement(SellerTab, {
      selectedProduct: null,
      selectedProductId: null,
      sellerProducts: [],
      transcriptProducts: [],
      onActiveProductChange: () => undefined,
    }));
  });
  root = created;
  container = host;
  return host;
}

/** Drive the controlled input the way a keystroke does. */
function typeRoomId(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function roomIdField(host: HTMLElement): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('#seller-event-id');
  if (!input) throw new Error('the Event room id field did not render');
  return input;
}

function latestPanels(): Record<string, { eventId?: string }> {
  const panels = captured.panels.at(-1);
  if (!panels) throw new Error('SellerDock never received panel props');
  return panels;
}

/** Room ids the boards actually fetched with, from both mechanisms. */
function fetchedEventIds(): string[] {
  const fromQueries = captured.queries
    .map((query) => query.args.eventId)
    .filter((value): value is string => typeof value === 'string');
  const fromPanels = DATA_PANELS
    .map((panel) => latestPanels()[panel]?.eventId)
    .filter((value): value is string => typeof value === 'string');
  return [...fromQueries, ...fromPanels];
}

beforeEach(() => {
  // Without this, React runs the updates OUTSIDE act's control and every
  // assertion below could pass by accident of flush timing.
  (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT = true;
  captured.queries.length = 0;
  captured.panels.length = 0;
  window.history.replaceState(null, '', '/?tab=seller&event=vintage-drop');
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  delete (globalThis as ActEnv).IS_REACT_ACT_ENVIRONMENT;
});

describe('Studio room-id editing (WI-39272)', () => {
  it('opens on the room the URL names', () => {
    const host = renderStudio();
    expect(roomIdField(host).value).toBe('vintage-drop');
    expect(latestPanels()['event-manager']?.eventId).toBe('vintage-drop');
  });

  it('fetches nothing for a whitespace draft, and leaves every board on the last real room', () => {
    const host = renderStudio();
    captured.queries.length = 0;

    typeRoomId(roomIdField(host), '   ');

    // The field shows what was typed — the draft is not silently discarded.
    expect(roomIdField(host).value).toBe('   ');

    // Nothing anywhere may carry an id that cannot name a room.
    for (const eventId of fetchedEventIds()) {
      expect(normalizedEventId(eventId), `"${eventId}" is not a fetchable room id`).not.toBeNull();
    }
    for (const panel of DATA_PANELS) {
      expect(latestPanels()[panel]?.eventId, `${panel} followed the draft`).toBe('vintage-drop');
    }
  });

  it('still refuses to start the event the seller actually typed', async () => {
    const host = renderStudio();
    typeRoomId(roomIdField(host), '   ');

    const start = latestPanels()['stage-status'] as { onStartEvent: () => void };
    await act(async () => {
      start.onStartEvent();
    });

    // Start reads the raw draft, so it rejects rather than going live in
    // vintage-drop — the regression a naive fix introduces.
    expect(host.textContent).toContain('Event ids must start');
  });

  it('follows a valid room id, normalizing it before anything fetches', () => {
    const host = renderStudio();

    // Positive control: the boards are not simply frozen.
    typeRoomId(roomIdField(host), 'midnight-vault');
    for (const panel of DATA_PANELS) {
      expect(latestPanels()[panel]?.eventId, `${panel} ignored a valid room id`).toBe('midnight-vault');
    }

    // A draft that only normalizes must be fetched in its normalized form:
    // the request path is encodeURIComponent(eventId), so raw casing 404s.
    typeRoomId(roomIdField(host), 'Sunday-Drop');
    expect(roomIdField(host).value).toBe('Sunday-Drop');
    for (const panel of DATA_PANELS) {
      expect(latestPanels()[panel]?.eventId, `${panel} fetched un-normalized casing`).toBe('sunday-drop');
    }
  });
});
