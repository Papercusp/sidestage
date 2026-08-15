import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';

import { cloneActionAudit, type ActionAuditStore } from '../actions/action-audit.store';
import type { ActionAuditKind, ActionAuditRecord, ActionStateSnapshot } from '../actions/action.types';

interface ActionAuditRow {
  id: string;
  event_id: string;
  actor_id: string;
  kind: ActionAuditKind;
  product_id: string;
  buyer_id: string | null;
  reason: string;
  before_state: ActionStateSnapshot | string;
  after_state: ActionStateSnapshot | string;
  client_request_id: string | null;
  rollback_of: string | null;
  rolled_back_at: Date | string | null;
  created_at: Date | string;
}

const SELECT_COLUMNS = `id, event_id, actor_id, kind, product_id, buyer_id, reason,
  before_state, after_state, client_request_id, rollback_of, rolled_back_at, created_at`;

function json<T>(value: T | string): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapRow(row: ActionAuditRow): ActionAuditRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    actorId: row.actor_id,
    kind: row.kind,
    productId: row.product_id,
    ...(row.buyer_id ? { buyerId: row.buyer_id } : {}),
    reason: row.reason,
    before: json(row.before_state),
    after: json(row.after_state),
    ...(row.client_request_id ? { clientRequestId: row.client_request_id } : {}),
    ...(row.rollback_of ? { rollbackOf: row.rollback_of } : {}),
    ...(row.rolled_back_at ? { rolledBackAt: iso(row.rolled_back_at) } : {}),
    createdAt: iso(row.created_at),
  };
}

/** PostgreSQL production authority for immutable action audit evidence. */
export class PgActionAuditStore implements ActionAuditStore {
  constructor(private readonly pool: Pool) {}

  async get(auditId: string): Promise<ActionAuditRecord | undefined> {
    const result = await this.pool.query<ActionAuditRow>(
      `SELECT ${SELECT_COLUMNS} FROM action_audit_entry WHERE id = $1`,
      [auditId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async findByRequest(eventId: string, clientRequestId: string): Promise<ActionAuditRecord | undefined> {
    const result = await this.pool.query<ActionAuditRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM action_audit_entry
        WHERE event_id = $1 AND client_request_id = $2`,
      [eventId, clientRequestId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async list(eventId: string): Promise<ActionAuditRecord[]> {
    const result = await this.pool.query<ActionAuditRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM action_audit_entry
        WHERE event_id = $1
        ORDER BY created_at, id`,
      [eventId],
    );
    return result.rows.map(mapRow);
  }

  async record(audit: ActionAuditRecord): Promise<ActionAuditRecord> {
    try {
      return await this.transaction(async (client) => {
        const inserted = await this.insert(client, audit, true);
        if (inserted) return inserted;
        const existing = audit.clientRequestId
          ? await client.query<ActionAuditRow>(
            `SELECT ${SELECT_COLUMNS}
               FROM action_audit_entry
              WHERE event_id = $1 AND client_request_id = $2`,
            [audit.eventId, audit.clientRequestId],
          )
          : null;
        if (existing?.rows[0]) return mapRow(existing.rows[0]);
        throw new ConflictException(`Audit ${audit.id} already exists`);
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
        throw new ConflictException(`Audit ${audit.id} already exists`);
      }
      throw error;
    }
  }

  async recordRollback(originalAuditId: string, audit: ActionAuditRecord): Promise<ActionAuditRecord> {
    return this.transaction(async (client) => {
      const original = await client.query<{ rolled_back_at: Date | null }>(
        'SELECT rolled_back_at FROM action_audit_entry WHERE id = $1 FOR UPDATE',
        [originalAuditId],
      );
      if (!original.rows[0]) throw new NotFoundException(`Audit ${originalAuditId} was not found`);
      if (original.rows[0].rolled_back_at) {
        throw new ConflictException(`Audit ${originalAuditId} was already rolled back`);
      }
      let inserted: ActionAuditRecord | undefined;
      try {
        inserted = await this.insert(client, audit, false);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
          throw new ConflictException(`Audit ${originalAuditId} was already rolled back`);
        }
        throw error;
      }
      if (!inserted) throw new ConflictException(`Audit ${originalAuditId} was already rolled back`);
      await client.query(
        'UPDATE action_audit_entry SET rolled_back_at = $2 WHERE id = $1',
        [originalAuditId, audit.createdAt],
      );
      return inserted;
    });
  }

  private async insert(
    client: PoolClient,
    audit: ActionAuditRecord,
    dedupeRequest: boolean,
  ): Promise<ActionAuditRecord | undefined> {
    const onConflict = dedupeRequest && audit.clientRequestId
      ? 'ON CONFLICT (event_id, client_request_id) WHERE client_request_id IS NOT NULL DO NOTHING'
      : '';
    const result = await client.query<ActionAuditRow>(
      `INSERT INTO action_audit_entry
         (id, event_id, actor_id, kind, product_id, buyer_id, reason,
          before_state, after_state, client_request_id, rollback_of, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12)
       ${onConflict}
       RETURNING ${SELECT_COLUMNS}`,
      [
        audit.id,
        audit.eventId,
        audit.actorId,
        audit.kind,
        audit.productId,
        audit.buyerId ?? null,
        audit.reason,
        JSON.stringify(audit.before),
        JSON.stringify(audit.after),
        audit.clientRequestId ?? null,
        audit.rollbackOf ?? null,
        audit.createdAt,
      ],
    );
    return result.rows[0] ? cloneActionAudit(mapRow(result.rows[0])) : undefined;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
