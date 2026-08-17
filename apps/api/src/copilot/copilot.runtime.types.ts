import type {
  ActionResult,
  GroundingContext,
  GuardrailDecision,
} from './copilot.types';

export type CopilotProposalStatus =
  | 'pending'
  | 'approved'
  | 'skipped'
  | 'blocked'
  | 'executed';

export interface CopilotQuestion {
  id: string;
  eventId: string;
  buyerId: string;
  buyerName: string;
  text: string;
  createdAt: string;
  /**
   * Product properties the answer turns on. Carried on the question rather than
   * recomputed at generation time so the proposal records what was actually
   * asked for — a reply is only verifiable against the properties the asker
   * named.
   */
  requiredProperties?: readonly string[];
}

export interface CopilotProposalDecision {
  actorId: string;
  decidedAt: string;
  sentMessageId?: string;
  auditId?: string;
}

/** Durable seller-review record; the browser never owns proposal truth. */
export interface CopilotProposal {
  id: string;
  eventId: string;
  sourceMessageId: string;
  question: CopilotQuestion;
  reply: string;
  citations: string[];
  context: GroundingContext;
  groundingFingerprint: string;
  replyGuardrail: GuardrailDecision;
  action?: ActionResult;
  /** Measured end-to-end generation latency for the visible release budget. */
  latencyMs?: number;
  status: CopilotProposalStatus;
  revision: number;
  error?: string;
  decision?: CopilotProposalDecision;
  createdAt: string;
  updatedAt: string;
}

export interface CopilotProposalStore {
  list(eventId: string): Promise<CopilotProposal[]>;
  get(id: string): Promise<CopilotProposal | undefined>;
  findBySourceMessage(eventId: string, sourceMessageId: string): Promise<CopilotProposal | undefined>;
  put(proposal: CopilotProposal): Promise<void>;
  replace(proposal: CopilotProposal, expectedRevision: number): Promise<boolean>;
}

export interface CreateCopilotTurnInput {
  message: string;
  buyerId?: string;
  buyerName?: string;
  sourceMessageId?: string;
  /**
   * Catalog properties the seller needs the answer to cover (e.g. `battery-life`).
   * Naming them is what enables the research fallback: when the catalog cannot
   * answer them, a labelled web round runs, and when that round is incomplete
   * the resulting draft is blocked instead of sent.
   */
  requiredProperties?: readonly string[];
}

export interface ReviewCopilotReplyInput {
  actorId?: string;
  reply?: string;
}

export interface ConfirmCopilotActionInput {
  actorId?: string;
}

export const COPILOT_PROPOSAL_STORE = Symbol('COPILOT_PROPOSAL_STORE');
export const COPILOT_PIPELINE = Symbol('COPILOT_PIPELINE');
