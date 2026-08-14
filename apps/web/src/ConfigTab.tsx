import { useCallback, useEffect, useRef, useState } from 'react';
import { useSyncMutate, useSyncQuery } from '@papercusp/sync';
import { resolveApiBaseUrl } from './catalog';
import { TabHeader } from './components/TabHeader';
import { browserEventId } from './event-identity';

interface EventGuardrails {
  priceChanges: boolean;
  inventoryClaims: boolean;
  buyerSensitive: boolean;
}

export interface EventConfigView {
  eventId: string;
  name: string;
  replyTone: 'warm' | 'playful' | 'minimal';
  guardrails: EventGuardrails;
  updatedAt: string;
}

export type EventConfigUpdate = Pick<EventConfigView, 'name' | 'replyTone' | 'guardrails'>;

type SaveState = 'idle' | 'saving' | 'saved' | 'error' | 'offline';

const GUARDRAIL_COPY: ReadonlyArray<{ key: keyof EventGuardrails; title: string; detail: string }> = [
  { key: 'priceChanges', title: 'Price changes', detail: 'Never invent a discount or bundle.' },
  { key: 'inventoryClaims', title: 'Inventory claims', detail: 'Use the latest catalog quantity only.' },
  { key: 'buyerSensitive', title: 'Buyer-sensitive topics', detail: 'Keep uncertain replies in review.' },
];

export function offlineEventConfig(eventId: string): EventConfigView {
  return {
    eventId,
    name: 'Sunday vintage drop',
    replyTone: 'warm',
    guardrails: { priceChanges: true, inventoryClaims: true, buyerSensitive: true },
    updatedAt: new Date(0).toISOString(),
  };
}

export function eventConfigUpdate(config: EventConfigView): EventConfigUpdate {
  return {
    name: config.name,
    replyTone: config.replyTone,
    guardrails: config.guardrails,
  };
}

/**
 * Real event configuration (P-105): loads and persists via
 * /events/:eventId/config, and the saved guardrails derive the policy the
 * server-side action guard enforces — the toggle IS the policy.
 */
export function ConfigTab() {
  const eventId = browserEventId();
  const [config, setConfig] = useState<EventConfigView | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const appliedRevision = useRef<string | null>(null);

  const configQuery = useSyncQuery<EventConfigView>({
    queryName: 'event.config',
    args: { eventId },
    pollIntervalMs: 30_000,
  });

  const saveFallback = useCallback(async (input: EventConfigUpdate) => {
    const response = await fetch(`${resolveApiBaseUrl()}/events/${encodeURIComponent(eventId)}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as EventConfigView;
  }, [eventId]);
  const mutateConfig = useSyncMutate<EventConfigUpdate, EventConfigView>('event.updateConfig', saveFallback);

  useEffect(() => {
    const loaded = configQuery.data?.[0];
    if (loaded && loaded.updatedAt !== appliedRevision.current) {
      appliedRevision.current = loaded.updatedAt;
      setConfig(loaded);
      setSaveState((current) => current === 'offline' ? 'idle' : current);
      return;
    }
    if (configQuery.error) {
      setSaveState('offline');
      setConfig((current) => current ?? offlineEventConfig(eventId));
    }
  }, [configQuery.data, configQuery.error, eventId]);

  const save = async () => {
    if (!config) return;
    setSaveState('saving');
    try {
      const saved = await mutateConfig(eventConfigUpdate(config));
      appliedRevision.current = saved.updatedAt;
      setConfig(saved);
      setSaveState('saved');
      setSavedAt(new Date());
      configQuery.invalidate();
    } catch {
      setSaveState('error');
    }
  };

  if (!config) {
    return (
      <div className="tab-layout density-compact">
        <TabHeader
          eyebrow="Config / event guardrails"
          title="Make the safe choice easy."
          copy="Set the defaults your copilot should respect before the first buyer joins the room."
        />
        <p className="muted">Loading event settings…</p>
      </div>
    );
  }

  return (
    <div className="tab-layout density-compact">
      <TabHeader
        eyebrow="Config / event guardrails"
        title="Make the safe choice easy."
        copy="Set the defaults your copilot should respect before the first buyer joins the room."
      />
      <div className="config-grid">
        <section className="settings-panel" aria-labelledby="event-settings-title">
          <div className="panel-kicker">Event settings</div>
          <h2 id="event-settings-title">{config.name}</h2>
          <label className="field-label" htmlFor="event-name">Event name</label>
          <input
            id="event-name"
            className="text-input"
            value={config.name}
            onChange={(event) => setConfig({ ...config, name: event.target.value })}
          />
          <label className="field-label" htmlFor="reply-tone">Reply tone</label>
          <select
            id="reply-tone"
            className="text-input"
            value={config.replyTone}
            onChange={(event) => setConfig({ ...config, replyTone: event.target.value as EventConfigView['replyTone'] })}
          >
            <option value="warm">Warm and concise</option>
            <option value="playful">Playful and bright</option>
            <option value="minimal">Minimal and direct</option>
          </select>
        </section>
        <section className="settings-panel" aria-labelledby="guardrails-title">
          <div className="panel-kicker">Guardrails</div>
          <h2 id="guardrails-title">Always ask before send</h2>
          {GUARDRAIL_COPY.map(({ key, title, detail }) => (
            <label className="toggle-row" key={key}>
              <input
                type="checkbox"
                checked={config.guardrails[key]}
                onChange={(event) => setConfig({
                  ...config,
                  guardrails: { ...config.guardrails, [key]: event.target.checked },
                })}
              />
              {' '}
              <span><strong>{title}</strong><small>{detail}</small></span>
            </label>
          ))}
        </section>
      </div>
      <div className="config-footer">
        <span className="config-save-state" role="status">
          {saveState === 'saving' ? 'Saving…'
            : saveState === 'saved' && savedAt ? `Saved ${savedAt.toLocaleTimeString()}`
            : saveState === 'error' ? 'Save failed — check the API and try again.'
            : saveState === 'offline' ? 'API unreachable — showing defaults; changes will not persist.'
            : `Event: ${config.eventId}`}
        </span>
        <button className="button primary config-save" type="button" onClick={() => void save()} disabled={saveState === 'saving'}>
          Save event defaults
        </button>
      </div>
    </div>
  );
}
