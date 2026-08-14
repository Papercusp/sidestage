import type { Pool } from 'pg';
import type { CopilotProposal, CopilotProposalStore } from './copilot.runtime.types';

function clone(proposal: CopilotProposal): CopilotProposal {
  return structuredClone(proposal);
}

export class InMemoryCopilotProposalStore implements CopilotProposalStore {
  private readonly proposals = new Map<string, CopilotProposal>();

  async list(eventId: string): Promise<CopilotProposal[]> {
    return [...this.proposals.values()]
      .filter((proposal) => proposal.eventId === eventId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(clone);
  }

  async get(id: string): Promise<CopilotProposal | undefined> {
    const proposal = this.proposals.get(id);
    return proposal ? clone(proposal) : undefined;
  }

  async findBySourceMessage(eventId: string, sourceMessageId: string): Promise<CopilotProposal | undefined> {
    const proposal = [...this.proposals.values()].find(
      (candidate) => candidate.eventId === eventId && candidate.sourceMessageId === sourceMessageId,
    );
    return proposal ? clone(proposal) : undefined;
  }

  async put(proposal: CopilotProposal): Promise<void> {
    if (this.proposals.has(proposal.id)) throw new Error(`Copilot proposal ${proposal.id} already exists`);
    const duplicate = await this.findBySourceMessage(proposal.eventId, proposal.sourceMessageId);
    if (duplicate) return;
    this.proposals.set(proposal.id, clone(proposal));
  }

  async replace(proposal: CopilotProposal, expectedRevision: number): Promise<boolean> {
    const current = this.proposals.get(proposal.id);
    if (!current || current.revision !== expectedRevision) return false;
    this.proposals.set(proposal.id, clone(proposal));
    return true;
  }
}

export class PgCopilotProposalStore implements CopilotProposalStore {
  constructor(private readonly pool: Pool) {}

  async list(eventId: string): Promise<CopilotProposal[]> {
    const result = await this.pool.query<{ payload: CopilotProposal }>(
      'SELECT payload FROM copilot_proposal WHERE event_id = $1 ORDER BY created_at DESC',
      [eventId],
    );
    return result.rows.map((row) => row.payload);
  }

  async get(id: string): Promise<CopilotProposal | undefined> {
    const result = await this.pool.query<{ payload: CopilotProposal }>(
      'SELECT payload FROM copilot_proposal WHERE id = $1',
      [id],
    );
    return result.rows[0]?.payload;
  }

  async findBySourceMessage(eventId: string, sourceMessageId: string): Promise<CopilotProposal | undefined> {
    const result = await this.pool.query<{ payload: CopilotProposal }>(
      'SELECT payload FROM copilot_proposal WHERE event_id = $1 AND source_message_id = $2',
      [eventId, sourceMessageId],
    );
    return result.rows[0]?.payload;
  }

  async put(proposal: CopilotProposal): Promise<void> {
    await this.pool.query(
      `INSERT INTO copilot_proposal
        (id, event_id, source_message_id, status, revision, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)
       ON CONFLICT (event_id, source_message_id) DO NOTHING`,
      [
        proposal.id,
        proposal.eventId,
        proposal.sourceMessageId,
        proposal.status,
        proposal.revision,
        JSON.stringify(proposal),
        proposal.createdAt,
        proposal.updatedAt,
      ],
    );
  }

  async replace(proposal: CopilotProposal, expectedRevision: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE copilot_proposal
       SET status = $2, revision = $3, payload = $4::jsonb, updated_at = $5::timestamptz
       WHERE id = $1 AND revision = $6`,
      [proposal.id, proposal.status, proposal.revision, JSON.stringify(proposal), proposal.updatedAt, expectedRevision],
    );
    return (result.rowCount ?? 0) === 1;
  }
}
