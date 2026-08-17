import { describe, expect, it } from 'vitest';

import { DeterministicScoutReplyModel } from './scout.service';
import type { Cart } from '../cart/cart.service';
import type { ProductCard } from './scout.types';

/**
 * WI-39741 — the owner asked Scout "are there any laptops for sale" and got a
 * flat no that quoted the whole question back. The ANSWER was true (the demo
 * catalog holds no laptops); the REPLY was the defect, because echoing the
 * sentence reads exactly like a failed substring search and naming nothing the
 * catalog does hold is ungrounded when the rows are right there.
 */
const cart = { id: 'cart-1', items: [] } as unknown as Cart;
const card = (title: string): ProductCard => ({
  productId: title.toLowerCase().replace(/\s+/g, '-'),
  title,
  description: '',
  priceCents: 1000,
  availableQty: 1,
  attributes: {},
});
const ALTERNATIVES = [card('Harbor Kettle'), card('Arc Table Lamp'), card('Cloud ANC Headphones')];
const model = new DeterministicScoutReplyModel();
const OWNER_QUESTION = 'are there any laptops for sale';

describe('WI-39741 — a no-match reply is grounded, not an echo', () => {
  it('never quotes the buyer’s whole question back', async () => {
    const reply = await model.generate({
      message: OWNER_QUESTION, products: [], cart, alternatives: ALTERNATIVES,
    });
    expect(reply).not.toContain(OWNER_QUESTION);
  });

  it('names the subject and real inventory it DOES have', async () => {
    const reply = await model.generate({
      message: OWNER_QUESTION, products: [], cart, alternatives: ALTERNATIVES,
    });
    expect(reply).toContain('laptops');
    expect(reply).toContain('Harbor Kettle');
  });

  it('degrades honestly when no alternatives could be fetched', async () => {
    const reply = await model.generate({
      message: OWNER_QUESTION, products: [], cart, alternatives: [],
    });
    expect(reply).not.toContain(OWNER_QUESTION);
    expect(reply.toLowerCase()).toContain('laptops');
    // No invented stock: nothing is claimed to be available.
    expect(reply).not.toContain('What I do have includes');
  });

  it('CONTROL — a real match still lists the matched products', async () => {
    const reply = await model.generate({
      message: 'kettle', products: [card('Harbor Kettle')], cart,
    });
    expect(reply).toContain('Harbor Kettle');
    expect(reply).toContain('verified option');
  });
});
