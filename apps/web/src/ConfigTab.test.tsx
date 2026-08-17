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
      canSave: true,
      neverSaved: false,
      completedRequired: 3,
      totalRequired: 3,
      issue: null,
    });
    expect(configReadiness({ ...CONFIG, name: '  ' })).toMatchObject({
      ready: false,
      canSave: false,
      completedRequired: 2,
    });
  });

  /* WI-39274 — this pane claimed "3 of 3 sections / Ready / Event settings are
     complete" next to a colocated readiness report saying the Config tab had
     never been saved, because `ready` was `name.trim() !== ''` and the other two
     sections were hardcoded complete. The epoch updatedAt is the server's
     deliberate never-saved sentinel (apps/api/src/config/event-config.service.ts),
     and apps/api/src/rehearsals/preflight.ts blocks on `Date.parse(updatedAt)===0`
     — so a Ready claim here is a direct contradiction of the authority. */
  const NEVER_SAVED: EventConfigView = {
    ...CONFIG,
    name: 'Sunday vintage drop', // the DEFAULT_EVENT_NAME preflight calls out
    updatedAt: new Date(0).toISOString(),
  };

  it('never claims Ready or 3-of-3 for an event running on unsaved defaults', () => {
    expect(configReadiness(NEVER_SAVED)).toMatchObject({
      ready: false,
      neverSaved: true,
      completedRequired: 0,
      totalRequired: 3,
    });
    expect(configReadiness(NEVER_SAVED).issue).toBeTruthy();
  });

  it('still allows SAVING an unsaved-defaults config — the save is what clears it', () => {
    // Regression guard: `ready` and `canSave` were once one flag, so making
    // `ready` honest about the epoch sentinel would have made the config
    // permanently unsaveable (ConfigEditor.submit and EventSettingsPanel.save
    // both gate on it).
    expect(configReadiness(NEVER_SAVED).canSave).toBe(true);
    expect(configReadiness({ ...NEVER_SAVED, name: '  ' }).canSave).toBe(false);
  });

  it('renders the epoch sentinel as Never saved, never as a locale date', () => {
    const html = renderToStaticMarkup(
      <ConfigEditor
        config={NEVER_SAVED}
        baseline={NEVER_SAVED}
        saveState="idle"
        savedAt={null}
        onChange={() => undefined}
        onSave={() => undefined}
      />,
    );

    expect(html).toContain('Never saved');
    // The exact production symptom: the sentinel localized into a 1969/1970
    // timestamp that reads as a real save having happened.
    expect(html).not.toContain('1969');
    expect(html).not.toContain('1970');
    // And the pane must not claim completeness while preflight blocks.
    expect(html).not.toContain('Event settings are complete');
    expect(html).not.toContain('3 of 3 sections');
    expect(html).toContain('0 of 3 sections');
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
    expect(html).toContain('Save event settings');
    /* [owner:Avi 2026-08-17] The event-preflight section was removed from this
       tab outright. Asserted as absence so it cannot drift back in: the
       'Configuration readiness' progressbar above is a DIFFERENT surface that
       stays, and the two read almost identically in a diff. */
    expect(html).not.toContain('Event readiness');
    expect(html).not.toContain('Current event · preflight');
    expect(html).not.toContain('Run event preflight');
    expect(html).toContain('No unsaved changes');
    expect(html).not.toContain('Open Rehearse');
  });
});
