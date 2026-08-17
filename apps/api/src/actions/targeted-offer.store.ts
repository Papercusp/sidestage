import { ConflictException, NotFoundException } from '@nestjs/common';

import type { TargetedOffer } from './action.types';

export const TARGETED_OFFER_STORE = Symbol('TARGETED_OFFER_STORE');

export type TargetedOfferStatus = TargetedOffer['status'];

/** What the guarded-action executor knows at the moment it mints an offer. */
export interface TargetedOfferDraft extends TargetedOffer {
  createdAt: string;
  /** The guarded action this offer came from, once its audit row exists. */
  auditId?: string;
  /** The originating command's mutation key; makes creation retry-safe. */
  clientRequestId?: string;
}

/** An offer as the durable authority holds it. */
export interface StoredTargetedOffer extends TargetedOffer {
  createdAt: string;
  updatedAt: string;
  /** Optimistic-concurrency token; every status write bumps it. */
  version: number;
  acceptedAt?: string;
  cancelledAt?: string;
  auditId?: string;
  clientRequestId?: string;
}

/**
 * One authority for targeted offers, shared by the seller action executor and
 * the buyer inbox / checkout readers.
 *
 * The boundary mirrors {@link ActionItemStore}: reads are plain, and the one
 * mutating verb compares versions so a second API process cannot silently
 * overwrite a newer buyer decision. Offers are LIVE STATE, not evidence — the
 * immutable record of what an action did lives in `action_audit_entry`, whose
 * before/after snapshots embed the offers as they stood. That split is why
 * {@link TargetedOfferStore.remove} may delete a row outright during rollback:
 * the action is being un-done, and its audit trail retains the proof.
 */
export interface TargetedOfferStore {
  get(offerId: string): Promise<StoredTargetedOffer | undefined>;
  /** Newest-first, matching the buyer inbox ordering. */
  listForBuyer(buyerId: string): Promise<StoredTargetedOffer[]>;
  /** Every offer written against one event item, for audit snapshots. */
  listForEventProduct(eventId: string, productId: string): Promise<StoredTargetedOffer[]>;
  /**
   * Creates the offer, or returns the offer an earlier attempt at the SAME
   * command already created (matched on eventId + clientRequestId).
   */
  create(offer: TargetedOfferDraft): Promise<StoredTargetedOffer>;
  /**
   * Compare-and-set the lifecycle status. Throws ConflictException when the
   * stored version has moved, so a stale reader retries against fresh state.
   */
  setStatus(
    offerId: string,
    expectedVersion: number,
    status: TargetedOfferStatus,
    at: string,
  ): Promise<StoredTargetedOffer>;
  /**
   * Records which guarded action minted this offer, once that action's audit
   * row exists. Provenance backfill, not a state change: it does NOT bump the
   * version, and it never overwrites an audit id already recorded.
   */
  attachAudit(offerId: string, auditId: string): Promise<void>;
  /** Removes offers a rollback un-did. Missing ids are a no-op. */
  remove(offerIds: readonly string[]): Promise<void>;
}

export function cloneStoredOffer(offer: StoredTargetedOffer): StoredTargetedOffer {
  return { ...offer };
}

/** Strips the storage-only fields the domain contract does not carry. */
export function toDomainOffer(offer: StoredTargetedOffer): TargetedOffer {
  return {
    id: offer.id,
    eventId: offer.eventId,
    eventItemId: offer.eventItemId,
    productId: offer.productId,
    buyerId: offer.buyerId,
    priceCents: offer.priceCents,
    quantity: offer.quantity,
    status: offer.status,
    createdAt: offer.createdAt,
  };
}

export function sortOffersNewestFirst(
  offers: Iterable<StoredTargetedOffer>,
): StoredTargetedOffer[] {
  return [...offers]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id))
    .map(cloneStoredOffer);
}

/** Explicit fallback/test adapter. Production selects PgTargetedOfferStore. */
export class InMemoryTargetedOfferStore implements TargetedOfferStore {
  readonly #offers = new Map<string, StoredTargetedOffer>();
  readonly #requestIds = new Map<string, string>();

  async get(offerId: string): Promise<StoredTargetedOffer | undefined> {
    const offer = this.#offers.get(offerId);
    return offer ? cloneStoredOffer(offer) : undefined;
  }

  async listForBuyer(buyerId: string): Promise<StoredTargetedOffer[]> {
    return sortOffersNewestFirst(
      [...this.#offers.values()].filter((offer) => offer.buyerId === buyerId),
    );
  }

  async listForEventProduct(eventId: string, productId: string): Promise<StoredTargetedOffer[]> {
    return sortOffersNewestFirst(
      [...this.#offers.values()].filter(
        (offer) => offer.eventId === eventId && offer.productId === productId,
      ),
    );
  }

  async create(draft: TargetedOfferDraft): Promise<StoredTargetedOffer> {
    if (draft.clientRequestId) {
      const existingId = this.#requestIds.get(this.requestKey(draft.eventId, draft.clientRequestId));
      if (existingId) {
        const existing = this.#offers.get(existingId);
        if (existing) return cloneStoredOffer(existing);
      }
    }
    if (this.#offers.has(draft.id)) throw new ConflictException(`Offer ${draft.id} already exists`);
    const stored: StoredTargetedOffer = {
      ...draft,
      version: 1,
      updatedAt: draft.createdAt,
    };
    this.#offers.set(stored.id, cloneStoredOffer(stored));
    if (draft.clientRequestId) {
      this.#requestIds.set(this.requestKey(draft.eventId, draft.clientRequestId), stored.id);
    }
    return cloneStoredOffer(stored);
  }

  async setStatus(
    offerId: string,
    expectedVersion: number,
    status: TargetedOfferStatus,
    at: string,
  ): Promise<StoredTargetedOffer> {
    const current = this.#offers.get(offerId);
    if (!current) throw new NotFoundException('Offer was not found');
    if (current.version !== expectedVersion) {
      throw new ConflictException('Offer changed; reload it and retry');
    }
    const next: StoredTargetedOffer = {
      ...current,
      status,
      version: current.version + 1,
      updatedAt: at,
      ...(status === 'accepted' ? { acceptedAt: current.acceptedAt ?? at } : {}),
      ...(status === 'cancelled' ? { cancelledAt: current.cancelledAt ?? at } : {}),
    };
    this.#offers.set(offerId, next);
    return cloneStoredOffer(next);
  }

  async attachAudit(offerId: string, auditId: string): Promise<void> {
    const current = this.#offers.get(offerId);
    if (!current || current.auditId) return;
    this.#offers.set(offerId, { ...current, auditId });
  }

  async remove(offerIds: readonly string[]): Promise<void> {
    for (const offerId of offerIds) {
      const offer = this.#offers.get(offerId);
      if (!offer) continue;
      this.#offers.delete(offerId);
      if (offer.clientRequestId) {
        this.#requestIds.delete(this.requestKey(offer.eventId, offer.clientRequestId));
      }
    }
  }

  private requestKey(eventId: string, clientRequestId: string): string {
    return `${eventId}\u0000${clientRequestId}`;
  }
}
