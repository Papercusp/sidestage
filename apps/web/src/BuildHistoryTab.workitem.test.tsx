/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BuildHistoryList, type BuildHistoryPlan, type BuildHistoryWorkItem } from './BuildHistoryTab';

/**
 * WI-38718 — the owner asked that every build-history entry link to its full work
 * item AND its full plan. These cover the work-item half plus the degrade case;
 * the plan half is covered by BuildHistoryTab.dialog.test.tsx.
 */

/** Five file-keyed lines on purpose: the CARD summary slices evidence to three, so
 *  a dialog showing only three would mean "read the full work item" is a lie. */
const COMPLETED_ITEM: BuildHistoryWorkItem = {
  id: 'WI-40001',
  kind: 'change',
  title: 'Link build history entries to their work item and plan',
  state: 'done',
  completedAt: '2026-08-14T21:00:00.000Z',
  completionAuthority: 'committed',
  completionSummary: 'Added the work-item record viewer.',
  completionEvidence: {
    filePathAlpha: 'apps/web/src/BuildHistoryTab.tsx',
    filePathBravo: 'apps/web/src/build-history.css',
    filePathCharlie: 'libs/ui-primitives/src/ProjectHistoryView.tsx',
    filePathDelta: 'libs/ui-primitives/src/index.ts',
    filePathEcho: 'apps/web/src/BuildHistoryTab.workitem.test.tsx',
    testResult: 'vitest: 21 passed',
  },
  commits: [],
};

/** A row from before the association existed: no work-item ref to link to. */
const REFLESS_ITEM: BuildHistoryWorkItem = {
  ...COMPLETED_ITEM,
  id: '',
  title: 'Legacy row recorded before work-item refs existed',
  completionEvidence: null,
  completionSummary: null,
};

function planWith(items: BuildHistoryWorkItem[]): BuildHistoryPlan {
  return {
    slug: 'sidestage-build-history-record-links-2026-08-14',
    title: 'Build history record links',
    status: 'ready',
    updatedAt: '2026-08-14T22:10:57.495Z',
    contentHash: 'b'.repeat(64),
    markdown: '# Build history record links',
    frontmatter: {
      title: 'Build history record links',
      slug: 'sidestage-build-history-record-links-2026-08-14',
      status: 'ready',
    },
    items: [],
    decisions: [],
    completedItems: items,
    project: {
      id: 'sidestage',
      name: 'SideStage',
      repository: {
        provider: 'github',
        url: 'git@github.com:Papercusp/sidestage.git',
        webUrl: 'https://github.com/Papercusp/sidestage',
        defaultBranch: 'main',
      },
    },
    snapshot: {
      kind: 'papercusp-plan-export',
      workspace: 'papercusp-workspace',
      harness: 'sidestage',
      planPrefix: 'sidestage-',
      generatedAt: '2026-08-14T22:10:57.495Z',
      planCount: 1,
      generator: 'papercusp project-history generate',
    },
  };
}

const PLAN = planWith([COMPLETED_ITEM]);

let container: HTMLDivElement;
let root: Root;

async function renderHistory(props: {
  plan?: BuildHistoryPlan;
  initialWorkItem?: string | null;
  initialDocument?: string | null;
} = {}) {
  const plan = props.plan ?? PLAN;
  await act(async () => {
    root.render(
      <BuildHistoryList
        plans={[plan]}
        initialTarget={{ plan: plan.slug, item: plan.completedItems[0]?.id ?? null }}
        initialDocument={props.initialDocument}
        initialWorkItem={props.initialWorkItem}
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

describe('History work-item record links', () => {
  it('renders both record links on an entry and opens the work item from its durable link', async () => {
    await renderHistory();

    const workItemLink = container.querySelector<HTMLAnchorElement>('.build-item-actions a[href*="work-item="]');
    const planLink = container.querySelector<HTMLAnchorElement>('.build-item-actions a[href*="document="]');
    expect(workItemLink?.textContent).toContain('Read full work item');
    expect(planLink?.textContent).toContain('Read full plan');
    workItemLink?.focus();

    await click(workItemLink as HTMLAnchorElement);

    expect(new URL(window.location.href).searchParams.get('work-item')).toBe(COMPLETED_ITEM.id);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain(COMPLETED_ITEM.title);
    const provenance = document.querySelector('[aria-label="Work item provenance"]');
    expect(provenance?.textContent).toContain(COMPLETED_ITEM.id);
    expect(provenance?.textContent).toContain('committed');

    // The reverse link: a work item must reach its plan without hunting.
    expect(provenance?.querySelector<HTMLAnchorElement>('a')?.getAttribute('href')).toContain('document=');

    await act(async () => {
      window.history.back();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
    expect(new URL(window.location.href).searchParams.get('work-item')).toBeNull();
    expect(document.activeElement).toBe(workItemLink);
  });

  it('shows the COMPLETE evidence set, not the three-line card summary', async () => {
    await renderHistory();
    await click(container.querySelector('.build-item-actions a[href*="work-item="]') as HTMLAnchorElement);

    const evidence = document.querySelector('.build-work-item-dialog-evidence');
    expect(evidence).not.toBeNull();
    // All five file lines, where summarizeBuildItemEvidence would have kept three.
    for (const path of [
      'apps/web/src/BuildHistoryTab.tsx',
      'apps/web/src/build-history.css',
      'libs/ui-primitives/src/ProjectHistoryView.tsx',
      'libs/ui-primitives/src/index.ts',
      'apps/web/src/BuildHistoryTab.workitem.test.tsx',
    ]) {
      expect(evidence?.textContent).toContain(path);
    }
    expect(evidence?.textContent).toContain('vitest: 21 passed');
  });

  it('opens a direct deep link on first load and closes it in place', async () => {
    window.history.replaceState(
      {},
      '',
      `/?tab=history&plan=${PLAN.slug}&item=${COMPLETED_ITEM.id}&work-item=${COMPLETED_ITEM.id}`,
    );
    await renderHistory({ initialWorkItem: COMPLETED_ITEM.id });

    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await click(document.querySelector('[aria-label="Close work item"]') as HTMLButtonElement);

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const url = new URL(window.location.href);
    expect(url.searchParams.get('work-item')).toBeNull();
    expect(url.searchParams.get('tab')).toBe('history');
    expect(url.searchParams.get('plan')).toBe(PLAN.slug);
  });

  it('reports an unknown work item instead of rendering an empty record', async () => {
    await renderHistory({ initialWorkItem: 'WI-does-not-exist' });

    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('not in the committed History snapshot');
  });

  it('renders NO work-item control for an entry with no ref, and never a dead href', async () => {
    await renderHistory({ plan: planWith([REFLESS_ITEM]) });
    // A ref-less item cannot be an initialTarget, so the disclosure starts closed;
    // open it the way a reader would rather than asserting against an empty list.
    const disclosure = container.querySelector<HTMLDetailsElement>('.build-work-items-disclosure');
    expect(disclosure).not.toBeNull();
    await act(async () => {
      (disclosure as HTMLDetailsElement).open = true;
      disclosure?.dispatchEvent(new Event('toggle'));
    });
    expect(container.querySelector('.build-item')).not.toBeNull();

    // The plan half still links; the work-item half is absent rather than dead.
    expect(container.querySelector('.build-item-actions a[href*="work-item="]')).toBeNull();
    expect(container.querySelector('.build-item-actions a[href*="document="]')).not.toBeNull();
    for (const anchor of container.querySelectorAll('.build-item-actions a')) {
      expect(anchor.getAttribute('href')?.trim()).toBeTruthy();
    }
  });

  it('keeps one record viewer open at a time', async () => {
    await renderHistory();

    await click(container.querySelector('.build-item-actions a[href*="document="]') as HTMLAnchorElement);
    expect(new URL(window.location.href).searchParams.get('document')).toBe(PLAN.slug);

    await click(container.querySelector('.build-item-actions a[href*="work-item="]') as HTMLAnchorElement);

    const url = new URL(window.location.href);
    expect(url.searchParams.get('work-item')).toBe(COMPLETED_ITEM.id);
    expect(url.searchParams.get('document')).toBeNull();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(COMPLETED_ITEM.title);
  });
});
