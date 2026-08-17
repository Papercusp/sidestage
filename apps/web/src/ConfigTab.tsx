import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { DEMO_PRINCIPAL_HEADER, useSyncMutate, useSyncQuery } from '@papercusp/sync';
import { catalogDemoDataEnabled, resolveApiBaseUrl } from './catalog';
import { TabHeader } from './components/TabHeader';
import { browserEventId } from './event-identity';
import { EventReadinessPanel } from './EventReadinessPanel';
import './config.css';

export interface EventGuardrails {
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
  /**
   * The effective copilot policy, as `readEventConfigView` sends it
   * (event-config.controller.ts:42-50) — a published seller policy when one
   * exists, otherwise the guardrail-toggle derivation.
   *
   * `priceFloorCentsByProduct` is usually EMPTY here even though the server
   * enforces per-product floors: the derivation from the markdown cap runs
   * later, at the action boundary (event-policy-resolver.ts:45). A client that
   * needs the floor must derive it the same way — see
   * `seller/markdown-guard.ts`, whose differential test pins it to the server's
   * own `withDerivedPriceFloors`.
   */
  policy?: {
    automationLevel?: string;
    maxMarkdownPercent?: number;
    priceFloorCentsByProduct?: Record<string, number>;
  };
  policySource?: string;
  policyRevisionId?: string;
}

export type EventConfigUpdate = Pick<EventConfigView, 'name' | 'replyTone' | 'guardrails'>;

export type ConfigSaveState = 'idle' | 'saving' | 'saved' | 'error' | 'offline';

/** REST fallback headers share the same principal contract as sync transport. */
export function eventConfigRequestHeaders(principal?: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(principal ? { [DEMO_PRINCIPAL_HEADER]: principal } : {}),
  };
}

interface GuardrailCopy {
  key: keyof EventGuardrails;
  title: string;
  enabledDetail: string;
  disabledDetail: string;
  enabledBadge: string;
  disabledBadge: string;
}

const GUARDRAIL_COPY: ReadonlyArray<GuardrailCopy> = [
  {
    key: 'priceChanges',
    title: 'Confirm price changes',
    enabledDetail: 'Every markdown needs approval. Product floors derive from verified catalog prices.',
    disabledDetail: 'The copilot may apply price changes automatically within the active policy.',
    enabledBadge: 'Review first',
    disabledBadge: 'Auto allowed',
  },
  {
    key: 'inventoryClaims',
    title: 'Protect live inventory',
    enabledDetail: 'Availability claims use the latest catalog quantity before a reply is approved.',
    disabledDetail: 'Replies may use inventory context without requiring a fresh quantity check.',
    enabledBadge: 'Live quantity',
    disabledBadge: 'Not enforced',
  },
  {
    key: 'buyerSensitive',
    title: 'Keep sensitive replies in review',
    enabledDetail: 'Uncertain replies about payments, orders, or buyer data wait for seller approval.',
    disabledDetail: 'Sensitive-topic replies follow the active automation policy without this extra hold.',
    enabledBadge: 'Seller review',
    disabledBadge: 'Policy default',
  },
];

export interface ConfigReadiness {
  ready: boolean;
  completedRequired: number;
  totalRequired: number;
  issue: string | null;
}

export function configReadiness(config: EventConfigView): ConfigReadiness {
  const identityComplete = config.name.trim().length > 0;
  const completedRequired = (identityComplete ? 1 : 0) + 2;
  return {
    ready: identityComplete,
    completedRequired,
    totalRequired: 3,
    issue: identityComplete ? null : 'Event name is required before these defaults can be saved.',
  };
}

export function countConfigChanges(current: EventConfigView, baseline: EventConfigView | null): number {
  if (!baseline) return 0;
  return Number(current.name !== baseline.name)
    + Number(current.replyTone !== baseline.replyTone)
    + GUARDRAIL_COPY.reduce(
      (count, { key }) => count + Number(current.guardrails[key] !== baseline.guardrails[key]),
      0,
    );
}

export function offlineEventConfig(eventId: string): EventConfigView {
  return {
    eventId,
    name: 'Sunday vintage drop',
    replyTone: 'warm',
    guardrails: { priceChanges: true, inventoryClaims: true, buyerSensitive: true },
    updatedAt: new Date(0).toISOString(),
    policy: { automationLevel: 'confirm', maxMarkdownPercent: 30 },
    policySource: 'config-toggle',
  };
}

export function eventConfigUpdate(config: EventConfigView): EventConfigUpdate {
  return {
    name: config.name,
    replyTone: config.replyTone,
    guardrails: config.guardrails,
  };
}

function savedLabel(saveState: ConfigSaveState, savedAt: Date | null, dirtyCount: number): string {
  if (saveState === 'saving') return 'Saving event settings…';
  if (saveState === 'saved' && savedAt) return `Saved ${savedAt.toLocaleTimeString()}`;
  if (saveState === 'error') return 'Save failed — check the API and try again.';
  if (saveState === 'offline') return 'API unreachable — these fallback values cannot be persisted.';
  return dirtyCount > 0 ? 'Review the changes before saving.' : 'All changes are saved.';
}

function formattedRevision(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

export interface ConfigEditorProps {
  config: EventConfigView;
  baseline: EventConfigView | null;
  saveState: ConfigSaveState;
  savedAt: Date | null;
  apiBaseUrl?: string;
  onChange: (next: EventConfigView) => void;
  onSave: () => void;
}

export function ConfigEditor({
  config,
  baseline,
  saveState,
  savedAt,
  apiBaseUrl,
  onChange,
  onSave,
}: ConfigEditorProps) {
  const [validationVisible, setValidationVisible] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const idPrefix = useId();
  const eventNameId = `${idPrefix}-event-name`;
  const eventNameHelpId = `${idPrefix}-event-name-help`;
  const eventNameErrorId = `${idPrefix}-event-name-error`;
  const replyToneId = `${idPrefix}-reply-tone`;
  const readiness = configReadiness(config);
  const dirtyCount = countConfigChanges(config, baseline);
  const publishedPolicyActive = Boolean(config.policySource && config.policySource !== 'config-toggle');
  const progress = Math.round((readiness.completedRequired / readiness.totalRequired) * 100);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!readiness.ready) {
      setValidationVisible(true);
      nameInput.current?.focus();
      return;
    }
    setValidationVisible(false);
    onSave();
  };

  const update = (next: EventConfigView) => {
    onChange(next);
    if (next.name.trim()) setValidationVisible(false);
  };

  return (
    <form className="config-page" onSubmit={submit} noValidate>
      <div className={`config-readiness-banner ${readiness.ready ? publishedPolicyActive ? 'is-warning' : 'is-ready' : 'is-blocked'}`} role={readiness.ready ? 'status' : 'alert'}>
        <span className="config-readiness-mark" aria-hidden="true">{readiness.ready ? publishedPolicyActive ? 'i' : '✓' : '!'}</span>
        <div>
          <strong>
            {!readiness.ready
              ? 'Configuration needs attention'
              : publishedPolicyActive
                ? 'A published policy is active for this event'
                : 'Event settings are complete'}
          </strong>
          <p>
            {!readiness.ready
              ? readiness.issue
              : publishedPolicyActive
                ? `Saving here updates event settings; event preflight continues to use policy revision ${config.policyRevisionId ?? 'currently published'}.`
                : 'Price floors are derived from verified catalog prices, and event preflight reads this same configuration.'}
          </p>
        </div>
        {!readiness.ready ? (
          <button className="button secondary" type="button" onClick={() => nameInput.current?.focus()}>Fix event name</button>
        ) : null}
      </div>

      <div className="config-context-row">
        <div>
          <span className="config-context-label">Editing event</span>
          <strong>{config.name.trim() || 'Untitled event'}</strong>
        </div>
        <code>{config.eventId}</code>
      </div>

      <div className="config-page-grid">
        <section className="config-sections" aria-label="Event settings">
          <details className="config-section" open>
            <summary>
              <span><strong>Event identity</strong><small>What buyers see when they enter this event.</small></span>
              <span className={`config-section-status ${readiness.ready ? 'is-complete' : 'is-blocked'}`}>
                {readiness.ready ? 'Complete' : 'Required'}
              </span>
            </summary>
            <div className="config-section-content">
              <label className="config-field" htmlFor={eventNameId}>
                <span>Event name</span>
                <input
                  ref={nameInput}
                  id={eventNameId}
                  value={config.name}
                  aria-invalid={validationVisible && !readiness.ready ? true : undefined}
                  aria-describedby={validationVisible && !readiness.ready ? eventNameErrorId : eventNameHelpId}
                  onChange={(event) => update({ ...config, name: event.target.value })}
                />
                <small id={eventNameHelpId}>Shown in the room, event guide, and event-readiness evidence.</small>
                {validationVisible && !readiness.ready ? <small className="config-field-error" id={eventNameErrorId}>Enter an event name before saving.</small> : null}
              </label>
            </div>
          </details>

          <details className="config-section" open>
            <summary>
              <span><strong>Commerce guardrails</strong><small>Boundaries the seller and copilot must honor.</small></span>
              <span className="config-section-status is-complete">Configured</span>
            </summary>
            <div className="config-section-content config-guardrail-list">
              {GUARDRAIL_COPY.map((guardrail) => {
                const enabled = config.guardrails[guardrail.key];
                return (
                  <label className="config-check-row" key={guardrail.key}>
                    <input
                      type="checkbox"
                      checked={enabled}
                      onChange={(event) => update({
                        ...config,
                        guardrails: { ...config.guardrails, [guardrail.key]: event.target.checked },
                      })}
                    />
                    <span>
                      <strong>{guardrail.title}</strong>
                      <small>{enabled ? guardrail.enabledDetail : guardrail.disabledDetail}</small>
                    </span>
                    <span className={`config-policy-badge ${enabled ? '' : 'is-muted'}`}>
                      {enabled ? guardrail.enabledBadge : guardrail.disabledBadge}
                    </span>
                  </label>
                );
              })}
            </div>
          </details>

          <details className="config-section" open>
            <summary>
              <span><strong>Copilot behavior</strong><small>How suggestions should sound to the seller and buyer.</small></span>
              <span className="config-section-status is-complete">Complete</span>
            </summary>
            <div className="config-section-content">
              <label className="config-field" htmlFor={replyToneId}>
                <span>Reply tone</span>
                <select
                  id={replyToneId}
                  value={config.replyTone}
                  onChange={(event) => update({ ...config, replyTone: event.target.value as EventConfigView['replyTone'] })}
                >
                  <option value="warm">Warm and concise</option>
                  <option value="playful">Playful and bright</option>
                  <option value="minimal">Minimal and direct</option>
                </select>
                <small>This changes phrasing, never the safety checks above.</small>
              </label>
            </div>
          </details>
        </section>

        <aside className="config-summary" aria-label="Readiness summary">
          <article className="config-summary-card">
            <div className="config-summary-heading">
              <div><span>Settings completeness</span><h2>{readiness.completedRequired} of {readiness.totalRequired} sections</h2></div>
              <span className={`config-section-status ${readiness.ready ? 'is-complete' : 'is-blocked'}`}>{readiness.ready ? 'Ready' : 'Blocked'}</span>
            </div>
            <div className="config-progress" role="progressbar" aria-label="Configuration readiness" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
              <span style={{ width: `${progress}%` }} />
            </div>
            <dl className="config-readiness-list">
              <div><dt>Event identity</dt><dd className={readiness.ready ? 'is-complete' : 'is-blocked'}>{readiness.ready ? 'Complete' : 'Required'}</dd></div>
              <div><dt>Commerce guardrails</dt><dd className="is-complete">Configured</dd></div>
              <div><dt>Copilot behavior</dt><dd className="is-complete">Complete</dd></div>
            </dl>
          </article>

          <article className="config-summary-card">
            <div className="config-summary-heading">
              <div><span>Effective policy</span><h2>{publishedPolicyActive ? 'Published policy' : 'Event defaults'}</h2></div>
            </div>
            <p className="config-summary-copy">
              {publishedPolicyActive
                ? 'A published policy currently has precedence over the toggles on this page.'
                : config.guardrails.priceChanges
                  ? `Seller confirmation is required; markdowns are capped at ${config.policy?.maxMarkdownPercent ?? 30}%.`
                  : 'Automatic price actions are allowed by the current event defaults.'}
            </p>
            <div className="config-revision">
              <span>Last server revision</span>
              <strong>{formattedRevision(config.updatedAt)}</strong>
            </div>
          </article>
        </aside>
      </div>

      <EventReadinessPanel eventId={config.eventId} />

      <footer className="config-save-bar">
        <p>
          <strong>{dirtyCount === 0 ? 'No unsaved changes' : `${dirtyCount} unsaved ${dirtyCount === 1 ? 'change' : 'changes'}`}</strong>
          <span className={saveState === 'error' || saveState === 'offline' ? 'is-error' : ''} role="status">
            {savedLabel(saveState, savedAt, dirtyCount)}
          </span>
        </p>
        <div>
          <button className="button primary" type="submit" disabled={saveState === 'saving' || dirtyCount === 0}>
            {saveState === 'saving' ? 'Saving…' : 'Save event settings'}
          </button>
        </div>
      </footer>
    </form>
  );
}

/**
 * Real event configuration (P-105): loads and persists via
 * /events/:eventId/config, and the saved guardrails derive the policy the
 * server-side action guard enforces — the toggle IS the policy.
 */
export interface EventSettingsPanelProps {
  eventId: string;
  principal?: string;
  apiBaseUrl?: string;
  embedded?: boolean;
  /** Test/embed override; production builds default false via import.meta.env.DEV. */
  allowDemoData?: boolean;
}

/**
 * Reusable current-event settings surface. The same component is mounted as a
 * Studio dock tab and inside Event Manager once an event exists, so edits and
 * readiness evidence cannot drift into parallel implementations.
 */
export function EventSettingsPanel({
  eventId,
  principal,
  apiBaseUrl,
  embedded = false,
  allowDemoData = catalogDemoDataEnabled(),
}: EventSettingsPanelProps) {
  const [config, setConfig] = useState<EventConfigView | null>(null);
  const [baseline, setBaseline] = useState<EventConfigView | null>(null);
  const [saveState, setSaveState] = useState<ConfigSaveState>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const appliedRevision = useRef<string | null>(null);

  const configQuery = useSyncQuery<EventConfigView>({
    queryName: 'event.config',
    args: { eventId },
    pollIntervalMs: 30_000,
  });

  const saveFallback = useCallback(async (input: EventConfigUpdate) => {
    const response = await fetch(`${resolveApiBaseUrl(apiBaseUrl)}/events/${encodeURIComponent(eventId)}/config`, {
      method: 'PUT',
      headers: eventConfigRequestHeaders(principal),
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as EventConfigView;
  }, [apiBaseUrl, eventId, principal]);
  const mutateConfig = useSyncMutate<EventConfigUpdate, EventConfigView>('event.updateConfig', saveFallback);

  useEffect(() => {
    const loaded = configQuery.data?.[0];
    if (loaded && loaded.updatedAt !== appliedRevision.current) {
      appliedRevision.current = loaded.updatedAt;
      setConfig(loaded);
      setBaseline(loaded);
      setSaveState((current) => current === 'offline' ? 'idle' : current);
      return;
    }
    if (configQuery.error) {
      setSaveState('offline');
      if (!allowDemoData) {
        setConfig(null);
        setBaseline(null);
        return;
      }
      setConfig((current) => {
        if (current) return current;
        const fallback = offlineEventConfig(eventId);
        setBaseline(fallback);
        return fallback;
      });
    }
  }, [allowDemoData, configQuery.data, configQuery.error, eventId]);

  const updateConfig = (next: EventConfigView) => {
    setConfig(next);
    setSaveState((current) => current === 'offline' ? current : 'idle');
  };

  const save = async () => {
    if (!config || !configReadiness(config).ready) return;
    setSaveState('saving');
    try {
      const saved = await mutateConfig(eventConfigUpdate(config));
      appliedRevision.current = saved.updatedAt;
      setConfig(saved);
      setBaseline(saved);
      setSaveState('saved');
      setSavedAt(new Date());
      configQuery.invalidate();
    } catch {
      setSaveState('error');
    }
  };

  if (configQuery.error && !allowDemoData) {
    return (
      <div className={embedded ? 'event-settings-panel is-embedded' : 'tab-layout density-compact'}>
        <div className="config-readiness-banner is-blocked" role="alert">
          <span className="config-readiness-mark" aria-hidden="true">!</span>
          <div>
            <strong>Event settings unavailable</strong>
            <p>No fallback configuration is shown because source data could not be loaded or persisted.</p>
          </div>
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className={embedded ? 'event-settings-panel is-embedded config-loading' : 'tab-layout density-compact config-loading'} role="status">
        {embedded ? (
          <header className="event-settings-panel-heading">
            <p className="eyebrow">Current event</p>
            <h2>Event settings &amp; readiness</h2>
            <p>Configure this event and verify the same policy and lineup before going live.</p>
          </header>
        ) : (
          <TabHeader
            eyebrow="Current event"
            title="Event settings & readiness"
            copy="Configure this event and verify its policy and reserved lineup in one place."
          />
        )}
        <p>Loading event settings…</p>
      </div>
    );
  }

  return (
    <div className={embedded ? 'event-settings-panel is-embedded' : 'tab-layout density-compact'}>
      {embedded ? (
        <header className="event-settings-panel-heading">
          <p className="eyebrow">Current event</p>
          <h2>Event settings &amp; readiness</h2>
          <p>Configure this event and verify the same policy and lineup before going live.</p>
        </header>
      ) : (
        <TabHeader
          eyebrow="Current event"
          title="Event settings & readiness"
          copy="Configure this event and verify its policy and reserved lineup in one place."
        />
      )}
      <ConfigEditor
        config={config}
        baseline={baseline}
        saveState={saveState}
        savedAt={savedAt}
        apiBaseUrl={apiBaseUrl}
        onChange={updateConfig}
        onSave={() => void save()}
      />
    </div>
  );
}

/** Legacy direct surface kept for compatibility; navigation resolves config URLs to Studio. */
export function ConfigTab() {
  return <EventSettingsPanel eventId={browserEventId()} />;
}
