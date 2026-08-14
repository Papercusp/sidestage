/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { EventChat, resolveApiOrigin, syncEndpointFor } from './EventChat';

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

  it('renders the seller full-chat view without a buyer composer', () => {
    const markup = renderToStaticMarkup(
      <EventChat
        eventId="sunday-drop"
        role="seller"
        userId="seller-1"
        displayName="Host"
        apiBaseUrl="https://sidestage.example"
      />,
    );

    expect(markup).toContain('Seller view is read-only');
    expect(markup).not.toContain('Message the room');
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
});
