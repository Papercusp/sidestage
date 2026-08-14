import { renderToStaticMarkup } from 'react-dom/server';
import { SyncContext } from '@papercusp/sync';
import { describe, expect, it, vi } from 'vitest';
import {
  ConfigEditor,
  EventSettingsPanel,
  configReadiness,
  countConfigChanges,
  eventConfigRequestHeaders,
  eventConfigUpdate,
  offlineEventConfig,
  type EventConfigView,
} from './ConfigTab';

const CONFIG: EventConfigView = {
  eventId: 'event-1',
  name: 'Friday drop',
  replyTone: 'playful',
  guardrails: { priceChanges: true, inventoryClaims: false, buyerSensitive: true },
  updatedAt: '2026-08-14T00:00:00.000Z',
  policy: { automationLevel: 'confirm', maxMarkdownPercent: 30 },
  policySource: 'config-toggle',
};

describe('ConfigTab sync mapping', () => {
  it('uses the canonical demo principal on the REST save fallback', () => {
    expect(eventConfigRequestHeaders('demo-avi')).toEqual({
      'content-type': 'application/json',
      'x-demo-principal': 'demo-avi',
    });
    expect(eventConfigRequestHeaders()).toEqual({
      'content-type': 'application/json',
    });
  });

  it('maps the named-query row into an update without sending server-owned fields', () => {
    expect(eventConfigUpdate(CONFIG)).toEqual({
      name: 'Friday drop',
      replyTone: 'playful',
      guardrails: { priceChanges: true, inventoryClaims: false, buyerSensitive: true },
    });
  });

  it('keeps safe fallback defaults for an explicit development demo', () => {
    expect(offlineEventConfig('event-offline')).toMatchObject({
      eventId: 'event-offline',
      replyTone: 'warm',
      guardrails: { priceChanges: true, inventoryClaims: true, buyerSensitive: true },
    });
  });

  it('alerts and withholds fabricated settings when the production source is unavailable', () => {
    const useDataImpl = vi.fn(() => ({
      data: [],
      loading: false,
      fetching: false,
      transport: 'SSE',
      invalidate: vi.fn(),
      error: new Error('settings unavailable'),
    }));

    const html = renderToStaticMarkup(
      <SyncContext.Provider value={{ transport: 'SSE', useDataImpl, prefetch: vi.fn() } as never}>
        <EventSettingsPanel eventId="event-offline" allowDemoData={false} />
      </SyncContext.Provider>,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Event settings unavailable');
    expect(html).toContain('No fallback configuration is shown');
    expect(html).not.toContain('Sunday vintage drop');
  });

  it('counts only seller-owned persisted fields as unsaved changes', () => {
    expect(countConfigChanges(CONFIG, CONFIG)).toBe(0);
    expect(countConfigChanges({
      ...CONFIG,
      name: 'Saturday drop',
      guardrails: { ...CONFIG.guardrails, inventoryClaims: true },
      policyRevisionId: 'server-owned-change',
    }, CONFIG)).toBe(2);
  });

  it('blocks only an invalid event identity and keeps policy choices explicit', () => {
    expect(configReadiness(CONFIG)).toEqual({
      ready: true,
      completedRequired: 3,
      totalRequired: 3,
      issue: null,
    });
    expect(configReadiness({ ...CONFIG, name: '  ' })).toMatchObject({
      ready: false,
      completedRequired: 2,
    });
  });

  it('renders the approved consequence-aware layout with real save and rehearsal actions', () => {
    const html = renderToStaticMarkup(
      <ConfigEditor
        config={{ ...CONFIG, policySource: 'published', policyRevisionId: 'policy-42' }}
        baseline={{ ...CONFIG, policySource: 'published', policyRevisionId: 'policy-42' }}
        saveState="idle"
        savedAt={null}
        onChange={() => undefined}
        onSave={() => undefined}
      />,
    );

    expect(html).toContain('A published policy is active for this event');
    expect(html).toContain('Event identity');
    expect(html).toContain('Commerce guardrails');
    expect(html).toContain('Copilot behavior');
    expect(html).toContain('Configuration readiness');
    expect(html).toContain('Event readiness');
    expect(html).toContain('Running event preflight');
    expect(html).toContain('Save event settings');
    expect(html).toContain('No unsaved changes');
    expect(html).not.toContain('Open Rehearse');
  });
});
