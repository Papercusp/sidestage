import { ConflictException, NotFoundException } from '@nestjs/common';

import type { ActionAuditRecord } from './action.types';

export const ACTION_AUDIT_STORE = Symbol('ACTION_AUDIT_STORE');

export interface ActionAuditStore {
  get(auditId: string): Promise<ActionAuditRecord | undefined>;
  findByRequest(eventId: string, clientRequestId: string): Promise<ActionAuditRecord | undefined>;
  list(eventId: string): Promise<ActionAuditRecord[]>;
  record(audit: ActionAuditRecord): Promise<ActionAuditRecord>;
  recordRollback(originalAuditId: string, audit: ActionAuditRecord): Promise<ActionAuditRecord>;
}

export function cloneActionAudit(audit: ActionAuditRecord): ActionAuditRecord {
  return structuredClone(audit);
}

/** Explicit fallback/test adapter; production selects the PostgreSQL store. */
export class InMemoryActionAuditStore implements ActionAuditStore {
  readonly #audits = new Map<string, ActionAuditRecord>();
  readonly #requestIds = new Map<string, string>();

  async get(auditId: string): Promise<ActionAuditRecord | undefined> {
    const audit = this.#audits.get(auditId);
    return audit ? cloneActionAudit(audit) : undefined;
  }

  async findByRequest(eventId: string, clientRequestId: string): Promise<ActionAuditRecord | undefined> {
    const id = this.#requestIds.get(this.requestKey(eventId, clientRequestId));
    return id ? this.get(id) : undefined;
  }

  async list(eventId: string): Promise<ActionAuditRecord[]> {
    return [...this.#audits.values()]
      .filter((audit) => audit.eventId === eventId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map(cloneActionAudit);
  }

  async record(audit: ActionAuditRecord): Promise<ActionAuditRecord> {
    if (audit.clientRequestId) {
      const key = this.requestKey(audit.eventId, audit.clientRequestId);
      const existingId = this.#requestIds.get(key);
      if (existingId) return cloneActionAudit(this.#audits.get(existingId)!);
      this.#requestIds.set(key, audit.id);
    }
    if (this.#audits.has(audit.id)) throw new ConflictException(`Audit ${audit.id} already exists`);
    this.#audits.set(audit.id, cloneActionAudit(audit));
    return cloneActionAudit(audit);
  }

  async recordRollback(originalAuditId: string, audit: ActionAuditRecord): Promise<ActionAuditRecord> {
    const original = this.#audits.get(originalAuditId);
    if (!original) throw new NotFoundException(`Audit ${originalAuditId} was not found`);
    if (original.rolledBackAt) throw new ConflictException(`Audit ${originalAuditId} was already rolled back`);
    if ([...this.#audits.values()].some((entry) => entry.rollbackOf === originalAuditId)) {
      throw new ConflictException(`Audit ${originalAuditId} was already rolled back`);
    }
    const next = cloneActionAudit(audit);
    this.#audits.set(next.id, next);
    this.#audits.set(originalAuditId, { ...original, rolledBackAt: next.createdAt });
    return cloneActionAudit(next);
  }

  private requestKey(eventId: string, clientRequestId: string): string {
    return `${eventId}\u0000${clientRequestId}`;
  }
}
