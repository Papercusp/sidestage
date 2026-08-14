import { describe, expect, it } from 'vitest';
import { studioBoardConfig } from './SellerTab';

function panelIds(seed: () => { root: unknown }): string[] {
  const visit = (node: unknown): string[] => {
    const current = node as {
      kind?: string;
      children?: unknown[];
      panels?: Array<{ id: string }>;
    };
    return current.kind === 'tabs'
      ? (current.panels ?? []).map((panel) => panel.id)
      : (current.children ?? []).flatMap(visit);
  };
  return visit(seed().root);
}

describe('Studio board selection', () => {
  it('maps the default view to the independently persisted live-operation board', () => {
    const config = studioBoardConfig('active-event');
    expect(config.layoutName).toBe('seller-active-event');
    expect(config.resetEventName).toContain('active-event');
    expect(panelIds(config.layoutSeed)).toEqual([
      'stage-status',
      'copilot',
      'transcript',
      'on-deck',
      'run-of-show',
    ]);
  });

  it('maps Event Manager to its own persisted preparation board', () => {
    const active = studioBoardConfig('active-event');
    const manager = studioBoardConfig('event-manager');
    expect(manager.layoutName).toBe('seller-event-manager');
    expect(manager.resetEventName).toContain('event-manager');
    expect(panelIds(manager.layoutSeed)).toEqual([
      'event-manager',
      'event-settings',
      'run-of-show-planner',
    ]);
    expect(manager.layoutName).not.toBe(active.layoutName);
    expect(manager.resetEventName).not.toBe(active.resetEventName);
  });
});
