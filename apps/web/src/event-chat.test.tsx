/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { SyncContext } from '@papercusp/sync';
import { describe, expect, it, vi } from 'vitest';
import { EventChat, resolveApiOrigin, syncEndpointFor } from './EventChat';
import { rememberSellerAuctionToken, SELLER_AUCTION_TOKEN_KEY } from './events/api';

function enterText(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('EventChat', () => {
  it('normalizes the API origin and derives the shared sync endpoint', () => {
    expect(resolveApiOrigin('https://sidestage.example///')).toBe('https://sidestage.example');
    expect(syncEndpointFor('https://sidestage.example/')).toBe('https://sidestage.example/sync');
  });

  it('renders a buyer composer and the active-user stats seam', () => {
    const markup = renderToStaticMarkup(
      <EventChat
        eventId="sunday-drop"
        role="buyer"
        userId="buyer-1"
        displayName="Maya"
        eventTitle="Sunday vintage drop"
        apiBaseUrl="https://sidestage.example"
      />,
    );

    expect(markup).toContain('Sunday vintage drop');
    expect(markup).toContain('Message the room');
    expect(markup).toContain('Chat activity');
  });

  it('renders a first-class seller composer alongside the triage queue', () => {
    const markup = renderToStaticMarkup(
      <EventChat
        eventId="sunday-drop"
        role="seller"
        userId="seller-1"
        displayName="Host"
        apiBaseUrl="https://sidestage.example"
      />,
    );

    expect(markup).toContain('Reply to the room');
    expect(markup).toContain('Reply to buyers…');
    expect(markup).not.toContain('Seller view is read-only');
    expect(markup).toContain('Active participants');
    expect(markup).toContain('Message triage');
    expect(markup).toContain('Focused');
    expect(markup).toContain('All');
  });

  it('renders a compact Buyer audience surface without management chrome', () => {
    const markup = renderToStaticMarkup(
      <EventChat
        eventId="sunday-drop"
        role="buyer"
        userId="buyer-1"
        displayName="Maya"
        eventTitle="Sunday vintage drop"
        surface="audience-overlay"
        apiBaseUrl="https://sidestage.example"
      />,
    );

    expect(markup).toContain('class="event-chat-audience"');
    expect(markup).toContain('data-surface="audience-overlay"');
    expect(markup).toContain('data-video-chat-scroll="true"');
    expect(markup).toContain('aria-label="Sunday vintage drop audience chat"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('Say something…');
    expect(markup).toContain('Message the room');
    expect(markup).not.toContain('event-chat-card');
    expect(markup).not.toContain('Chat activity');
    expect(markup).not.toContain('Message triage');
    expect(markup).not.toContain('Active participants');
  });

  it('keeps the Seller audience surface read-only while management stays the default', () => {
    const audience = renderToStaticMarkup(
      <EventChat
        eventId="sunday-drop"
        role="seller"
        userId="seller-1"
        displayName="Host"
        surface="audience-overlay"
        apiBaseUrl="https://sidestage.example"
      />,
    );

    expect(audience).toContain('class="event-chat-audience"');
    expect(audience).not.toContain('Message the room');
    expect(audience).not.toContain('Seller view is read-only');
    expect(audience).not.toContain('Message triage');
  });

  it('sends a seller reply through the shared mutation fallback and echoes it locally', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const createdAt = new Date().toISOString();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      const json = url.endsWith('/messages')
        ? { id: 'seller-reply-1', eventId: 'sunday-drop', ...body, createdAt }
        : init?.method === 'DELETE'
          ? { ok: true }
          : { userId: 'seller-1', displayName: 'Host', role: 'seller', lastSeenAt: createdAt };
      return { ok: true, status: 200, json: async () => json, text: async () => '' } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    rememberSellerAuctionToken('seller-session-token');
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    const syncValue = {
      transport: 'POLLING' as const,
      principal: 'seller-demo',
      useDataImpl: () => ({
        data: [], loading: false, fetching: false, transport: 'POLLING' as const,
        invalidate: vi.fn(), error: null,
      }),
      prefetch: vi.fn(),
      mutate: null,
    };

    try {
      await act(async () => {
        root.render(
          <SyncContext.Provider value={syncValue}>
            <EventChat
              eventId="sunday-drop"
              role="seller"
              userId="seller-1"
              displayName="Host"
              apiBaseUrl="https://sidestage.example"
            />
          </SyncContext.Provider>,
        );
        await Promise.resolve();
      });

      const input = container.querySelector<HTMLInputElement>('#event-chat-message-sunday-drop');
      const form = container.querySelector<HTMLFormElement>('.event-chat-form');
      expect(input).not.toBeNull();
      expect(form).not.toBeNull();
      await act(async () => {
        enterText(input!, 'The blue mug is still available.');
      });
      await act(async () => {
        form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
        await Promise.resolve();
      });

      const messageCall = calls.find((call) => call.url.endsWith('/messages'));
      expect(JSON.parse(String(messageCall?.init?.body))).toEqual({
        userId: 'seller-1',
        displayName: 'Host',
        role: 'seller',
        text: 'The blue mug is still available.',
      });
      expect(new Headers(messageCall?.init?.headers).get('authorization')).toBe('Bearer seller-session-token');
      expect(new Headers(messageCall?.init?.headers).get('x-demo-principal')).toBe('seller-demo');
      expect(container.textContent).toContain('The blue mug is still available.');
      expect(input!.value).toBe('');
    } finally {
      await act(async () => root.unmount());
      sessionStorage.removeItem(SELLER_AUCTION_TOKEN_KEY);
      vi.unstubAllGlobals();
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it('keeps a failed seller reply editable and announces the transport error', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/messages')) {
        return { ok: false, status: 503, json: async () => ({}), text: async () => 'Room unavailable' } as Response;
      }
      const json = init?.method === 'DELETE'
        ? { ok: true }
        : { userId: 'seller-1', displayName: 'Host', role: 'seller', lastSeenAt: new Date().toISOString() };
      return { ok: true, status: 200, json: async () => json, text: async () => '' } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    const syncValue = {
      transport: 'POLLING' as const,
      principal: 'seller-demo',
      useDataImpl: () => ({
        data: [], loading: false, fetching: false, transport: 'POLLING' as const,
        invalidate: vi.fn(), error: null,
      }),
      prefetch: vi.fn(),
      mutate: null,
    };

    try {
      await act(async () => {
        root.render(
          <SyncContext.Provider value={syncValue}>
            <EventChat eventId="sunday-drop" role="seller" userId="seller-1" displayName="Host" />
          </SyncContext.Provider>,
        );
        await Promise.resolve();
      });
      const input = container.querySelector<HTMLInputElement>('#event-chat-message-sunday-drop')!;
      const form = container.querySelector<HTMLFormElement>('.event-chat-form')!;
      await act(async () => {
        enterText(input, 'Still here for questions.');
      });
      await act(async () => {
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(input.value).toBe('Still here for questions.');
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('Chat request failed (503): Room unavailable');
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it('keeps presence heartbeat and leave behavior through the REST fallbacks', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return {
        ok: true,
        status: 200,
        json: async () => init?.method === 'DELETE'
          ? { ok: true }
          : { userId: 'buyer-1', displayName: 'Maya', role: 'buyer', lastSeenAt: new Date().toISOString() },
        text: async () => '',
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          <EventChat
            eventId="sunday drop"
            role="buyer"
            userId="buyer/1"
            displayName="Maya"
            apiBaseUrl="https://sidestage.example/"
          />,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(calls[0]).toMatchObject({
        url: 'https://sidestage.example/chat/events/sunday%20drop/presence',
        init: { method: 'POST' },
      });
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
        userId: 'buyer/1', displayName: 'Maya', role: 'buyer',
      });

      await act(async () => {
        root.unmount();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(calls.at(-1)).toMatchObject({
        url: 'https://sidestage.example/chat/events/sunday%20drop/presence/buyer%2F1',
        init: { method: 'DELETE' },
      });
    } finally {
      vi.unstubAllGlobals();
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });

  it('pairs seller presence fallbacks with the principal and session credential', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return {
        ok: true,
        status: 200,
        json: async () => init?.method === 'DELETE'
          ? { ok: true }
          : { userId: 'seller-1', displayName: 'Host', role: 'seller', lastSeenAt: new Date().toISOString() },
        text: async () => '',
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    rememberSellerAuctionToken('seller-session-token');
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);
    const syncValue = {
      transport: 'POLLING' as const,
      principal: 'demo-1',
      useDataImpl: () => ({
        data: [], loading: false, fetching: false, transport: 'POLLING' as const,
        invalidate: vi.fn(), error: null,
      }),
      prefetch: vi.fn(),
      mutate: null,
    };

    try {
      await act(async () => {
        root.render(
          <SyncContext.Provider value={syncValue}>
            <EventChat
              eventId="sunday-drop"
              role="seller"
              userId="seller-1"
              displayName="Host"
              apiBaseUrl="https://sidestage.example"
            />
          </SyncContext.Provider>,
        );
        await Promise.resolve();
        await Promise.resolve();
      });

      const presence = calls.find((call) => call.init?.method === 'POST');
      expect(new Headers(presence?.init?.headers).get('authorization')).toBe('Bearer seller-session-token');
      expect(new Headers(presence?.init?.headers).get('x-demo-principal')).toBe('demo-1');

      await act(async () => {
        root.unmount();
        await Promise.resolve();
        await Promise.resolve();
      });
      const leave = calls.find((call) => call.init?.method === 'DELETE');
      expect(new Headers(leave?.init?.headers).get('authorization')).toBe('Bearer seller-session-token');
      expect(new Headers(leave?.init?.headers).get('x-demo-principal')).toBe('demo-1');
    } finally {
      sessionStorage.removeItem(SELLER_AUCTION_TOKEN_KEY);
      vi.unstubAllGlobals();
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});
