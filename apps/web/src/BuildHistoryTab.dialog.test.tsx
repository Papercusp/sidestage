/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/ui-primitives', () => ({
  PlanDocumentView: ({
    value,
    slug,
    items,
    decisions,
    assetBaseUrl,
    theme,
  }: {
    value: string;
    slug: string;
    items: unknown[];
    decisions: unknown[];
    assetBaseUrl: string;
    theme: string;
  }) => (
    <div
      data-testid="plan-document-view"
      data-slug={slug}
      data-item-count={items.length}
      data-decision-count={decisions.length}
      data-asset-base-url={assetBaseUrl}
      data-theme={theme}
    >
      {value}
    </div>
  ),
}));

import { BuildHistoryList, type BuildHistoryPlan } from './BuildHistoryTab';

const PLAN: BuildHistoryPlan = {
  slug: 'sidestage-history-plan-popup-2026-08-14',
  title: 'SideStage History tab and full Vditor plan popup',
  status: 'ready',
  updatedAt: '2026-08-14T22:10:57.495Z',
  contentHash: 'a'.repeat(64),
  markdown: '# SideStage History tab and full Vditor plan popup\n\n## Phase — Build',
  frontmatter: {
    title: 'SideStage History tab and full Vditor plan popup',
    slug: 'sidestage-history-plan-popup-2026-08-14',
    status: 'ready',
  },
  items: [{
    id: 'P-003',
    text: 'Add the History plan popup.',
    storedStatus: 'todo',
    effectiveStatus: 'todo',
    importance: 'high',
    riskTier: null,
    authority: null,
    blockedBy: [],
    phase: 'Phase — Build',
    lineNumber: 10,
  }],
  decisions: [{
    id: 'D-002',
    title: 'History popup is read-only and production-safe',
    body: 'The browser consumes a committed SideStage projection.',
    date: '2026-08-14',
    itemRefs: ['P-003'],
    lineNumber: 20,
  }],
  completedItems: [],
  snapshot: {
    kind: 'papercusp-plan-export',
    workspace: 'papercusp-workspace',
    harness: 'sidestage',
    planPrefix: 'sidestage-',
    generatedAt: '2026-08-14T22:10:57.495Z',
    planCount: 1,
    generator: 'scripts/generate-build-history-snapshot.mjs',
  },
};

let container: HTMLDivElement;
let root: Root;

async function renderHistory(props: { initialDocument?: string | null } = {}) {
  await act(async () => {
    root.render(
      <BuildHistoryList
        plans={[PLAN]}
        initialTarget={{ plan: PLAN.slug, item: null }}
        initialDocument={props.initialDocument}
        now={new Date('2026-08-14T23:00:00Z')}
      />,
    );
  });
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
  });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn();
  window.history.replaceState({}, '', '/?tab=history');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  vi.restoreAllMocks();
});

describe('History plan document dialog', () => {
  it('tolerates environments without scrollIntoView', async () => {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView');

    await renderHistory();
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });

    expect(container.querySelector(`#history-plan-${PLAN.slug}`)).not.toBeNull();
  });

  it('opens from a durable link, renders the shared read-only viewer, and follows browser Back', async () => {
    await renderHistory();
    const trigger = container.querySelector<HTMLAnchorElement>('a[href*="document="]');
    expect(trigger?.textContent).toContain('Read full plan');
    trigger?.focus();

    await click(trigger as HTMLAnchorElement);

    expect(new URL(window.location.href).searchParams.get('document')).toBe(PLAN.slug);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"] h2')?.textContent).toBe(PLAN.title);
    const viewer = document.querySelector<HTMLElement>('[data-testid="plan-document-view"]');
    expect(viewer?.dataset.slug).toBe(PLAN.slug);
    expect(viewer?.dataset.assetBaseUrl).toBe('/vditor');
    expect(viewer?.dataset.theme).toBe('light');
    expect(viewer?.dataset.itemCount).toBe('1');
    expect(viewer?.dataset.decisionCount).toBe('1');
    expect(document.querySelector('[aria-label="Plan snapshot provenance"]')?.textContent).toContain('papercusp-workspace / sidestage');

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(new URL(window.location.href).searchParams.get('document')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes a direct deep link in place without navigating away from History', async () => {
    window.history.replaceState(
      {},
      '',
      `/?tab=history&plan=${PLAN.slug}&document=${PLAN.slug}#history-plan-${PLAN.slug}`,
    );
    await renderHistory({ initialDocument: PLAN.slug });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const close = document.querySelector<HTMLButtonElement>('[aria-label="Close plan"]');
    await click(close as HTMLButtonElement);

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const url = new URL(window.location.href);
    expect(url.searchParams.get('document')).toBeNull();
    expect(url.searchParams.get('tab')).toBe('history');
    expect(url.searchParams.get('plan')).toBe(PLAN.slug);
  });
});
