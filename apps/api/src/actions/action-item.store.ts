import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ActionEventItem, ActionItemStageState } from './action.types';

export const ACTION_ITEM_STORE = Symbol('ACTION_ITEM_STORE');

export interface ActionItemDraft extends ActionEventItem {
  referencePriceCents: number;
  position: number;
  stageState: ActionItemStageState;
  onStage: boolean;
}

export interface StoredActionEventItem extends ActionItemDraft {
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ActionItemChange {
  expectedVersion: number;
  item: ActionItemDraft;
}

/**
 * One authority for the event lineup used by seller actions and buyer reads.
 * Registration is additive; writes are event-atomic and compare versions so a
 * second API process cannot silently overwrite a newer seller action.
 */
export interface ActionItemStore {
  list(eventId: string): Promise<StoredActionEventItem[]>;
  register(eventId: string, items: readonly ActionItemDraft[]): Promise<StoredActionEventItem[]>;
  write(eventId: string, changes: readonly ActionItemChange[]): Promise<StoredActionEventItem[]>;
}

export function cloneStoredActionItem(item: StoredActionEventItem): StoredActionEventItem {
  return { ...item, attributes: { ...item.attributes } };
}

function key(eventId: string, productId: string): string {
  return `${eventId}\u0000${productId}`;
}

function sortItems(items: Iterable<StoredActionEventItem>): StoredActionEventItem[] {
  return [...items]
    .sort((left, right) => left.position - right.position || left.eventItemId.localeCompare(right.eventItemId))
    .map(cloneStoredActionItem);
}

function assertOneOnStage(items: Iterable<ActionItemDraft>): void {
  const onStage = [...items].filter((item) => item.stageState === 'on-stage');
  if (onStage.length > 1) throw new ConflictException('Only one lineup item may be on stage for an event');
}

/** Explicit fallback/test adapter. Production selects PgActionItemStore. */
export class InMemoryActionItemStore implements ActionItemStore {
  private readonly items = new Map<string, StoredActionEventItem>();

  async list(eventId: string): Promise<StoredActionEventItem[]> {
    return sortItems([...this.items.values()].filter((item) => item.eventId === eventId));
  }

  async register(eventId: string, drafts: readonly ActionItemDraft[]): Promise<StoredActionEventItem[]> {
    if (drafts.filter((item) => item.stageState === 'on-stage').length > 1) {
      throw new ConflictException('Only one lineup item may be on stage for an event');
    }
    const next = new Map(this.items);
    const now = new Date().toISOString();
    if (drafts.some((item) => item.stageState === 'on-stage')) {
      for (const [itemKey, item] of next) {
        if (item.eventId === eventId && item.stageState === 'on-stage') {
          next.set(itemKey, {
            ...cloneStoredActionItem(item),
            stageState: 'queued',
            onStage: false,
            version: item.version + 1,
            updatedAt: now,
          });
        }
      }
    }
    for (const draft of drafts) {
      if (draft.eventId !== eventId) throw new ConflictException('Lineup item belongs to another event');
      const itemKey = key(eventId, draft.productId);
      const current = next.get(itemKey);
      const duplicateId = [...next.values()].find(
        (item) => item.eventItemId === draft.eventItemId && key(item.eventId, item.productId) !== itemKey,
      );
      if (duplicateId) throw new ConflictException(`Event item ${draft.eventItemId} is already registered`);
      next.set(itemKey, {
        ...draft,
        attributes: { ...draft.attributes },
        eventItemId: current?.eventItemId ?? draft.eventItemId,
        referencePriceCents: current?.referencePriceCents ?? draft.referencePriceCents,
        version: (current?.version ?? 0) + 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
    }
    assertOneOnStage([...next.values()].filter((item) => item.eventId === eventId));
    this.items.clear();
    for (const [itemKey, item] of next) this.items.set(itemKey, item);
    return this.list(eventId);
  }

  async write(eventId: string, changes: readonly ActionItemChange[]): Promise<StoredActionEventItem[]> {
    const next = new Map(this.items);
    const now = new Date().toISOString();
    for (const change of changes) {
      const itemKey = key(eventId, change.item.productId);
      const current = next.get(itemKey);
      if (!current) throw new NotFoundException(`Event item ${change.item.productId} was not found`);
      if (current.version !== change.expectedVersion) {
        throw new ConflictException(`Event item ${change.item.productId} changed; reload the lineup and retry`);
      }
      next.set(itemKey, {
        ...change.item,
        attributes: { ...change.item.attributes },
        eventId,
        eventItemId: current.eventItemId,
        referencePriceCents: current.referencePriceCents,
        position: current.position,
        version: current.version + 1,
        createdAt: current.createdAt,
        updatedAt: now,
      });
    }
    assertOneOnStage([...next.values()].filter((item) => item.eventId === eventId));
    this.items.clear();
    for (const [itemKey, item] of next) this.items.set(itemKey, item);
    return this.list(eventId);
  }
}
