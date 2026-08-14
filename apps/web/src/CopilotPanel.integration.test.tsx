/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SyncContext } from '@papercusp/sync';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopilotPanel, type CopilotProposal } from './CopilotPanel';

const baseProposal: CopilotProposal = {
  id: 'proposal-1',
  eventId: 'event-live',
  question: {
    buyerId: 'buyer-1',
    buyerName: 'Maya',
    text: 'Is the blue mug still available?',
    createdAt: '2026-08-14T15:00:00.000Z',
  },
  reply: 'Yes — the verified live listing has five blue mugs available.',
  citations: ['event-item:event-live:mug'],
  context: {
    sources: [{
      id: 'event-item:event-live:mug',
      kind: 'event-item',
      label: 'Blue mug live event listing',
    }],
  },
  status: 'pending',
  createdAt: '2026-08-14T15:00:01.000Z',
};

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  container.remove();
  delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

function button(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')]
    .find((candidate) => candidate.textContent === label);
  if (!match) throw new Error(`Expected button ${label}`);
  return match;
}

async function mount(proposal: CopilotProposal = baseProposal) {
  const invalidate = vi.fn();
  const queryRequests: unknown[] = [];
  const useDataImpl = <T,>(options: unknown) => {
    queryRequests.push(options);
    return {
      data: [proposal] as unknown as T[],
      loading: false,
      fetching: false,
      transport: 'POLLING' as const,
      invalidate,
      error: null,
    };
  };
  const createTurn = vi.fn(async () => proposal);
  const approve = vi.fn(async () => ({ ...proposal, status: 'approved' as const }));
  const skip = vi.fn(async () => ({ ...proposal, status: 'skipped' as const }));
  const confirmAction = vi.fn(async () => ({ ...proposal, status: 'executed' as const }));
  const chatSend = vi.fn();
  const value = {
    transport: 'POLLING' as const,
    principal: null,
    useDataImpl,
    prefetch: vi.fn(),
    mutate: {
      copilot: { createTurn, approve, skip, confirmAction },
      chat: { sendMessage: chatSend },
    },
  };

  await act(async () => {
    root?.render(
      <SyncContext.Provider value={value}>
        <CopilotPanel eventId="event-live" actorId="seller-7" apiBaseUrl="https://api.sidestage.test" />
      </SyncContext.Provider>,
    );
  });

  return { approve, chatSend, confirmAction, createTurn, invalidate, queryRequests, skip };
}

describe('CopilotPanel sync integration', () => {
  it('reads the live proposal queue and approves the grounded reply through the named mutator', async () => {
    const runtime = await mount();

    expect(runtime.queryRequests).toContainEqual({
      queryName: 'event.copilot.proposals',
      args: { eventId: 'event-live' },
    });
    expect(container.textContent).toContain('Blue mug live event listing');
    expect(container.querySelector('.live-badge')).toMatchObject({
      role: 'status',
      ariaLive: 'polite',
    });

    await act(async () => {
      button('Approve reply').click();
      await Promise.resolve();
    });

    expect(runtime.approve).toHaveBeenCalledTimes(1);
    expect(runtime.approve).toHaveBeenCalledWith({
      proposalId: 'proposal-1',
      actorId: 'seller-7',
      reply: baseProposal.reply,
    });
    expect(runtime.invalidate).toHaveBeenCalledTimes(1);
    expect(runtime.chatSend).not.toHaveBeenCalled();
  });

  it('skips through the proposal mutation without sending a chat message', async () => {
    const runtime = await mount();

    await act(async () => {
      button('Skip').click();
      await Promise.resolve();
    });

    expect(runtime.skip).toHaveBeenCalledTimes(1);
    expect(runtime.skip).toHaveBeenCalledWith({ proposalId: 'proposal-1', actorId: 'seller-7' });
    expect(runtime.invalidate).toHaveBeenCalledTimes(1);
    expect(runtime.approve).not.toHaveBeenCalled();
    expect(runtime.chatSend).not.toHaveBeenCalled();
  });

  it('marks a skipped proposal status as a polite atomic announcement', async () => {
    await mount({ ...baseProposal, status: 'skipped' });

    const status = container.querySelector('.copilot-review-status');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.getAttribute('aria-live')).toBe('polite');
    expect(status?.getAttribute('aria-atomic')).toBe('true');
  });

  it('requires the guarded action confirmation to use its dedicated mutation', async () => {
    const runtime = await mount({
      ...baseProposal,
      action: {
        proposal: {
          kind: 'targeted-offer',
          productId: 'mug',
          buyerId: 'buyer-1',
          quantity: 1,
          priceCents: 1_200,
          reason: 'Seller-confirmed live offer',
        },
        disposition: 'awaiting-confirmation',
        guardrail: { allowed: true },
      },
    });

    await act(async () => {
      button('Confirm action').click();
      await Promise.resolve();
    });

    expect(runtime.confirmAction).toHaveBeenCalledTimes(1);
    expect(runtime.confirmAction).toHaveBeenCalledWith({ proposalId: 'proposal-1', actorId: 'seller-7' });
    expect(runtime.invalidate).toHaveBeenCalledTimes(1);
  });
});
