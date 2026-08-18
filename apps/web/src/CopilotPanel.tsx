import { type FormEvent, useCallback, useState } from 'react';
import {
  DEMO_PRINCIPAL_HEADER,
  useRestSyncQuery,
  useSyncMutate,
  useSyncPrincipal,
} from '@papercusp/sync';
import { browserEventId } from './event-identity';
import { resolveApiOrigin } from './EventChat';

export type CopilotProposalStatus = 'pending' | 'approved' | 'skipped' | 'blocked' | 'executed';

interface CopilotSource {
  id: string;
  kind: 'event-item' | 'catalog-product' | 'web-research' | 'transcript' | 'policy';
  label: string;
}

interface CopilotAction {
  proposal: {
    kind: string;
    productId: string;
    quantity?: number;
    priceCents?: number;
    buyerId?: string;
    swapToProductId?: string;
    reason: string;
  };
  disposition: 'suggested' | 'awaiting-confirmation' | 'executed' | 'blocked';
  guardrail: { allowed: boolean; explanation?: string };
}

export interface CopilotProposal {
  id: string;
  eventId: string;
  question: {
    buyerId: string;
    buyerName: string;
    text: string;
    createdAt: string;
  };
  reply: string;
  citations: string[];
  context: { sources: CopilotSource[] };
  action?: CopilotAction;
  /** Absent on proposals stored before latency tracking reached the review queue. */
  latencyMs?: number;
  status: CopilotProposalStatus;
  error?: string;
  decision?: { sentMessageId?: string; auditId?: string };
  createdAt: string;
}

interface ProposalMutation {
  proposalId: string;
  actorId: string;
  reply?: string;
}

interface CreateTurnMutation {
  eventId: string;
  message: string;
  actorId: string;
  /**
   * Catalog properties the seller needs the answer to cover. Naming one is what
   * arms the research fallback server-side: a property the catalog cannot answer
   * runs a labelled web round, and an incomplete round blocks the draft instead
   * of sending it. Absent means "no research contract was named".
   */
  requiredProperties?: readonly string[];
}

/**
 * Split the seller's free-text property list into catalog property names.
 *
 * Blank entries are dropped rather than forwarded: the API can never satisfy an
 * empty property name, so passing one through would permanently pin the
 * incomplete-research block on for that turn. Duplicates collapse for the same
 * reason a duplicate cannot add evidence.
 */
export function parseRequiredProperties(raw: string): string[] {
  const named = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const property = part.trim();
    if (property) named.add(property);
  }
  return [...named];
}

export interface CopilotPanelProps {
  apiBaseUrl?: string;
  eventId?: string;
  actorId?: string;
}

async function mutateProposal<T>(apiOrigin: string, path: string, body: object, principal?: string): Promise<T> {
  const response = await fetch(`${apiOrigin}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(principal ? { [DEMO_PRINCIPAL_HEADER]: principal } : {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `Request failed (${response.status})`);
  return payload;
}

export function citedSources(proposal: CopilotProposal): CopilotSource[] {
  const cited = new Set(proposal.citations);
  return proposal.context.sources.filter((source) => cited.has(source.id));
}

export const PRODUCT_RESEARCH_LATENCY_BUDGET_MS = 2_000;

export function ProductResearchLatency({ latencyMs }: { latencyMs?: number }) {
  if (typeof latencyMs !== 'number' || !Number.isFinite(latencyMs)) return null;
  const roundedLatencyMs = Math.max(0, Math.round(latencyMs));
  const withinBudget = roundedLatencyMs < PRODUCT_RESEARCH_LATENCY_BUDGET_MS;
  return (
    <p className="copilot-research-latency" role="status">
      <span>Product research</span>
      <strong className={withinBudget ? 'status-success' : 'status-warning'}>
        {roundedLatencyMs}ms · {withinBudget ? 'within' : 'over'} the sub-2s budget
      </strong>
    </p>
  );
}

function actionLabel(action: CopilotAction['proposal']): string {
  const kind = action.kind.replaceAll('-', ' ');
  if (action.priceCents !== undefined) {
    const price = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
      .format(action.priceCents / 100);
    return `${kind} · ${price}`;
  }
  if (action.quantity !== undefined) return `${kind} · ${action.quantity} unit${action.quantity === 1 ? '' : 's'}`;
  return kind;
}

export interface CopilotProposalCardProps {
  proposal: CopilotProposal;
  draft: string;
  busy?: boolean;
  onDraftChange: (value: string) => void;
  onApprove: () => void;
  onSkip: () => void;
  onConfirmAction: () => void;
}

interface CopilotQueueItemProps {
  proposal: CopilotProposal;
  selected: boolean;
  onSelect: () => void;
}

function CopilotQueueItem({ proposal, selected, onSelect }: CopilotQueueItemProps) {
  const verifiedSourceCount = citedSources(proposal).length;
  return (
    <button
      className={`copilot-queue-item copilot-queue-item-${proposal.status}`}
      type="button"
      aria-label={`Review ${proposal.question.buyerName}: ${proposal.question.text}`}
      aria-pressed={selected}
      data-copilot-queue-item={proposal.id}
      onClick={onSelect}
    >
      <span className="copilot-queue-item-copy">
        <strong>{proposal.question.buyerName}</strong>
        <span>{proposal.question.text}</span>
      </span>
      <span className="copilot-queue-item-meta">
        <span>{verifiedSourceCount} verified source{verifiedSourceCount === 1 ? '' : 's'}</span>
        <span
          className="copilot-review-status"
          role={proposal.status === 'skipped' ? 'status' : undefined}
          aria-live={proposal.status === 'skipped' ? 'polite' : undefined}
          aria-atomic={proposal.status === 'skipped' ? true : undefined}
        >
          {proposal.status}
        </span>
      </span>
    </button>
  );
}

export function CopilotProposalCard({
  proposal,
  draft,
  busy = false,
  onDraftChange,
  onApprove,
  onSkip,
  onConfirmAction,
}: CopilotProposalCardProps) {
  const sources = citedSources(proposal);
  const replyReviewable = (proposal.status === 'pending' || proposal.status === 'executed')
    && !proposal.decision?.sentMessageId;
  const actionReviewable = Boolean(
    proposal.action
    && (proposal.status === 'pending' || proposal.status === 'approved')
    && !proposal.decision?.auditId
    && proposal.action.disposition !== 'blocked'
    && proposal.action.disposition !== 'executed',
  );

  return (
    <article className={`copilot-proposal copilot-review-${proposal.status}`} data-copilot-proposal={proposal.id}>
      <header className="copilot-review-heading">
        <div>
          <p className="panel-kicker">{proposal.question.buyerName}</p>
          <strong>{proposal.question.text}</strong>
        </div>
        <span
          className="copilot-review-status"
          role={proposal.status === 'skipped' ? 'status' : undefined}
          aria-live={proposal.status === 'skipped' ? 'polite' : undefined}
          aria-atomic={proposal.status === 'skipped' ? true : undefined}
        >
          {proposal.status}
        </span>
      </header>

      <ProductResearchLatency latencyMs={proposal.latencyMs} />

      {proposal.status === 'blocked' ? (
        <p className="copilot-blocked" role="alert">{proposal.error ?? 'This draft is blocked until verified facts are available.'}</p>
      ) : replyReviewable ? (
        <label className="copilot-reply-editor">
          <span>Seller reply</span>
          <textarea aria-label={`Reply to ${proposal.question.buyerName}`} value={draft} onChange={(event) => onDraftChange(event.target.value)} />
        </label>
      ) : (
        <p className="copilot-review-copy">{proposal.reply}</p>
      )}

      <div className="copilot-grounding" aria-label="Verified grounding">
        <span>Grounded by</span>
        {sources.length > 0 ? sources.map((source) => (
          <span className="copilot-source" key={source.id} title={source.id}>{source.label}</span>
        )) : <span className="copilot-source copilot-source-missing">No verified citation</span>}
      </div>

      {proposal.action ? (
        <div className={`copilot-action copilot-action-${proposal.action.disposition}`}>
          <div>
            <span>Guarded action</span>
            <strong>{actionLabel(proposal.action.proposal)}</strong>
            <small>{proposal.action.proposal.reason}</small>
          </div>
          {actionReviewable ? (
            <button className="button secondary" type="button" disabled={busy} onClick={onConfirmAction}>Confirm action</button>
          ) : null}
          {proposal.action.disposition === 'blocked' ? (
            <p>{proposal.action.guardrail.explanation ?? 'Seller policy blocked this action.'}</p>
          ) : null}
          {proposal.decision?.auditId ? <small>Executed with audit {proposal.decision.auditId}</small> : null}
        </div>
      ) : null}

      {replyReviewable || proposal.status === 'pending' ? (
        <div className="copilot-review-actions" aria-label="Copilot proposal actions">
          {replyReviewable ? (
            <button className="button primary" type="button" disabled={busy || !draft.trim()} onClick={onApprove}>Approve reply</button>
          ) : null}
          {proposal.status === 'pending' ? (
            <button className="button tertiary" type="button" disabled={busy} onClick={onSkip}>Skip</button>
          ) : null}
        </div>
      ) : null}
      {proposal.decision?.sentMessageId ? <p className="copilot-review-result" role="status">Reply sent to live event chat.</p> : null}
    </article>
  );
}

/** Seller-side review queue for event-grounded Copilot proposals. */
export function CopilotPanel({
  apiBaseUrl,
  eventId = browserEventId(),
  actorId = 'seller-copilot-review',
}: CopilotPanelProps) {
  const apiOrigin = resolveApiOrigin(apiBaseUrl);
  const principal = useSyncPrincipal() ?? actorId;
  // REST on every transport: `event.copilot.proposals` is a payload-jsonb
  // document store with no Zero leaf (D-025 / UNSYNCED_QUERY_REASONS).
  const proposals = useRestSyncQuery<CopilotProposal>({
    queryName: 'event.copilot.proposals',
    args: { eventId },
  });
  const [message, setMessage] = useState('');
  const [requiredPropertiesInput, setRequiredPropertiesInput] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedProposalId, setSelectedProposalId] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();

  const createFallback = useCallback((input: CreateTurnMutation) => mutateProposal<CopilotProposal>(
    apiOrigin,
    `/copilot/events/${encodeURIComponent(input.eventId)}/turns`,
    {
      message: input.message,
      buyerId: input.actorId,
      buyerName: 'Seller research',
      // Omitted rather than sent empty: the API reads an absent list as "no
      // properties were named", while `[]` would claim a contract that has no
      // members and can never be checked against a source.
      ...(input.requiredProperties?.length ? { requiredProperties: input.requiredProperties } : {}),
    },
    principal,
  ), [apiOrigin, principal]);
  const approveFallback = useCallback((input: ProposalMutation) => mutateProposal<CopilotProposal>(
    apiOrigin,
    `/copilot/proposals/${encodeURIComponent(input.proposalId)}/approve`,
    { actorId: input.actorId, reply: input.reply },
    principal,
  ), [apiOrigin, principal]);
  const skipFallback = useCallback((input: ProposalMutation) => mutateProposal<CopilotProposal>(
    apiOrigin,
    `/copilot/proposals/${encodeURIComponent(input.proposalId)}/skip`,
    { actorId: input.actorId },
    principal,
  ), [apiOrigin, principal]);
  const actionFallback = useCallback((input: ProposalMutation) => mutateProposal<CopilotProposal>(
    apiOrigin,
    `/copilot/proposals/${encodeURIComponent(input.proposalId)}/confirm-action`,
    { actorId: input.actorId },
    principal,
  ), [apiOrigin, principal]);
  const createTurn = useSyncMutate<CreateTurnMutation, CopilotProposal>('copilot.createTurn', createFallback);
  const approve = useSyncMutate<ProposalMutation, CopilotProposal>('copilot.approve', approveFallback);
  const skip = useSyncMutate<ProposalMutation, CopilotProposal>('copilot.skip', skipFallback);
  const confirmAction = useSyncMutate<ProposalMutation, CopilotProposal>('copilot.confirmAction', actionFallback);

  const run = useCallback(async (id: string, operation: () => Promise<unknown>) => {
    setBusyId(id);
    setError(undefined);
    try {
      await operation();
      proposals.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Copilot review failed');
    } finally {
      setBusyId(undefined);
    }
  }, [proposals]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = message.trim();
    if (!next || busyId) return;
    const requiredProperties = parseRequiredProperties(requiredPropertiesInput);
    await run('create', async () => {
      await createTurn({
        eventId,
        message: next,
        actorId,
        ...(requiredProperties.length ? { requiredProperties } : {}),
      });
      setMessage('');
      setRequiredPropertiesInput('');
    });
  }

  const rows = proposals.data ?? [];
  const selectedProposal = rows.find((proposal) => proposal.id === selectedProposalId) ?? rows[0];
  return (
    <section className="copilot-panel" aria-label="Seller copilot">
      <div className="copilot-panel-toolbar">
        <div className="copilot-panel-heading">
          <div>
            <p className="eyebrow">Grounded seller copilot</p>
            <h2>Review queue</h2>
          </div>
          <span className="live-badge" role="status" aria-live="polite" aria-atomic="true">
            {rows.filter((proposal) => proposal.status === 'pending').length} PENDING
          </span>
        </div>

        <form className="copilot-form" onSubmit={(event) => void submit(event)}>
          <label htmlFor="copilot-message">Research a buyer question</label>
          <div className="copilot-input-row">
            <input id="copilot-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Ask using live event facts" />
          </div>
          <label htmlFor="copilot-required-properties">Catalog properties the answer must cover</label>
          <div className="copilot-input-row">
            <input
              id="copilot-required-properties"
              value={requiredPropertiesInput}
              onChange={(event) => setRequiredPropertiesInput(event.target.value)}
              placeholder="battery-life, dishwasher-safe"
              aria-describedby="copilot-required-properties-hint"
            />
            <button className="button primary" type="submit" disabled={Boolean(busyId) || !message.trim()}>{busyId === 'create' ? 'Grounding…' : 'Prepare'}</button>
          </div>
          <p className="copilot-hint" id="copilot-required-properties-hint">
            Optional, comma separated. A property the catalog cannot answer runs a labelled research
            round; an incomplete round blocks the draft instead of sending it.
          </p>
        </form>
      </div>

      {error ? <p className="copilot-error" role="alert">{error}</p> : null}
      {proposals.error ? <p className="copilot-error" role="alert">Unable to load proposals. <button type="button" onClick={proposals.invalidate}>Try again</button></p> : null}
      {proposals.loading && rows.length === 0 ? <p className="copilot-empty" role="status">Loading grounded proposals…</p> : null}
      {!proposals.loading && rows.length === 0 ? <p className="copilot-empty">Buyer questions will appear here for seller review.</p> : null}

      {selectedProposal ? (
        <div className="copilot-workspace">
          <aside className="copilot-queue" aria-label="Copilot proposal queue">
            <div className="copilot-queue-heading">
              <strong>Queue</strong>
              <span>{rows.length} proposal{rows.length === 1 ? '' : 's'}</span>
            </div>
            <div className="copilot-queue-list">
              {rows.map((proposal) => (
                <CopilotQueueItem
                  key={proposal.id}
                  proposal={proposal}
                  selected={proposal.id === selectedProposal.id}
                  onSelect={() => setSelectedProposalId(proposal.id)}
                />
              ))}
            </div>
          </aside>

          <div className="copilot-inspector" aria-label={`Reviewing proposal from ${selectedProposal.question.buyerName}`}>
            <CopilotProposalCard
              proposal={selectedProposal}
              draft={drafts[selectedProposal.id] ?? selectedProposal.reply}
              busy={busyId === selectedProposal.id}
              onDraftChange={(value) => setDrafts((current) => ({ ...current, [selectedProposal.id]: value }))}
              onApprove={() => void run(selectedProposal.id, () => approve({
                proposalId: selectedProposal.id,
                actorId,
                reply: drafts[selectedProposal.id] ?? selectedProposal.reply,
              }))}
              onSkip={() => void run(selectedProposal.id, () => skip({ proposalId: selectedProposal.id, actorId }))}
              onConfirmAction={() => void run(selectedProposal.id, () => confirmAction({ proposalId: selectedProposal.id, actorId }))}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
