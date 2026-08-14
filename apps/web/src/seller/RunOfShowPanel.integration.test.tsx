/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@papercusp/sync', () => ({
  useSyncQuery: () => ({
    data: [{
      eventId: 'demo-room',
      entries: [
        { productId: 'planned-a', plannedDurationSec: 300, notes: 'Lead with the glaze.' },
        { productId: 'planned-b', plannedDurationSec: 120, notes: '' },
      ],
    }],
    loading: false,
    error: null,
  }),
}));

vi.mock('../events/api', () => ({
  fetchSellerEvent: vi.fn(async () => ({
    items: [
      { productId: 'planned-a', title: 'Aurora Cup' },
      { productId: 'planned-b', title: 'Beacon Mug' },
    ],
  })),
}));

import { RunOfShowPanel } from './RunOfShowPanel';
import { emptyStageLog, stageLogOnProductChange } from '../run-of-show';

describe('RunOfShowPanel integration', () => {
  it('stages a planned id even when its commerce detail is outside the catalog window', async () => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    const root = createRoot(container);

    try {
      await act(async () => {
        const stageLog = stageLogOnProductChange(emptyStageLog(), 'planned-a', Date.now());
        root.render(
          <RunOfShowPanel
            eventId="demo-room"
            stageLog={stageLog}
            activeProduct={null}
            onActiveProductChange={() => undefined}
          />,
        );
      });

      expect(container.textContent).toContain('Now');
      expect(container.textContent).toContain('Aurora Cup');
      expect(container.textContent).toContain('Lead with the glaze.');
      expect(container.textContent).toContain('Beacon Mug');
    } finally {
      await act(async () => root.unmount());
      delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    }
  });
});
