import { AuctionService, InMemoryAuctionInventory } from '../auction/auction.service';
import {
  buildRehearsalReport,
  centsToDollars,
  expectRefusal,
  runCase,
} from './rehearsal.report';
import type { RehearsalCaseResult, RehearsalReport } from './rehearsal.types';

/**
 * The auction rehearsal.
 *
 * A live auction is the moment with the most money and the least patience in
 * the whole product: bids arrive together, the clock is the referee, and a
 * mistake is visible to every buyer in the room at once. These cases drive the
 * real AuctionService against its real inventory seam and check the four things
 * a host is entitled to assume — the price only goes up, exactly one person
 * wins, stock is actually held for them, and the clock is final.
 */

const PRODUCT = 'aurora-cup';
const STOCK = 3;
const START_PRICE_CENTS = 2_000;

let sequence = 0;

interface ScriptedAuction {
  auctions: AuctionService;
  inventory: InMemoryAuctionInventory;
  eventId: string;
}

function scripted(): ScriptedAuction {
  const inventory = new InMemoryAuctionInventory();
  return { auctions: new AuctionService(inventory), inventory, eventId: `rehearsal-auction-${++sequence}` };
}

async function startOne(scriptedAuction: ScriptedAuction, quantity = 1, durationSec = 60) {
  return scriptedAuction.auctions.startAuction({
    eventId: scriptedAuction.eventId,
    eventItemId: `${scriptedAuction.eventId}:${PRODUCT}`,
    productId: PRODUCT,
    quantity,
    startingPriceCents: START_PRICE_CENTS,
    durationSec,
    availableQty: STOCK,
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

export async function runAuctionRehearsal(options: { now?: () => number } = {}): Promise<RehearsalReport> {
  const now = options.now ?? Date.now;
  const startedMs = now();
  const cases: RehearsalCaseResult[] = [];

  cases.push(await runCase(
    {
      caseId: 'start-holds-stock',
      title: 'Starting an auction holds the unit',
      expectation: `Opening an auction for 1 of ${STOCK} units must reserve that unit immediately, so it cannot also be sold in the shop while the auction runs.`,
    },
    async () => {
      const context = scripted();
      await startOne(context);
      const snapshot = await context.inventory.get(PRODUCT);
      const held = snapshot?.reservedQty === 1 && snapshot?.availableQty === STOCK - 1;
      return {
        passed: held,
        observed: held
          ? `1 unit held; ${snapshot?.availableQty} of ${STOCK} still sellable elsewhere.`
          : `Expected 1 unit held, saw reserved=${snapshot?.reservedQty} available=${snapshot?.availableQty}.`,
        evidence: { reserved: snapshot?.reservedQty ?? -1, available: snapshot?.availableQty ?? -1, stock: STOCK },
      };
    },
  ));

  cases.push(await runCase(
    {
      caseId: 'price-only-climbs',
      title: 'The price only ever climbs',
      expectation: 'Three rising bids must leave the price at the highest bid, having passed through each step in order.',
    },
    async () => {
      const context = scripted();
      const auction = await startOne(context);
      const observedPrices: number[] = [];
      for (const [bidderId, amountCents] of [['ana', 2_500], ['ben', 2_600], ['cleo', 2_700]] as const) {
        const updated = await context.auctions.placeBid(auction.id, { bidderId, amountCents });
        observedPrices.push(updated.currentPriceCents);
      }
      const climbing = observedPrices.every((price, index) => index === 0 || price > observedPrices[index - 1]!);
      const final = observedPrices.at(-1) ?? 0;
      return {
        passed: climbing && final === 2_700,
        observed: `Price moved ${observedPrices.map(centsToDollars).join(' → ')}.`,
        evidence: { finalPrice: centsToDollars(final), bids: observedPrices.length },
      };
    },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'under-bid-refused',
      title: 'A bid below the current price is refused',
      expectation: 'Once the price is $25.00, a $22.00 bid must be refused rather than quietly recorded as the new price.',
    },
    async () => {
      const context = scripted();
      const auction = await startOne(context);
      await context.auctions.placeBid(auction.id, { bidderId: 'ana', amountCents: 2_500 });
      return context.auctions.placeBid(auction.id, { bidderId: 'ben', amountCents: 2_200 });
    },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'tie-bid-refused',
      title: 'A bid matching the current price is refused',
      expectation: 'A bid equal to the standing price must be refused — matching is not beating, and letting it through would make the winner depend on arrival order alone.',
    },
    async () => {
      const context = scripted();
      const auction = await startOne(context);
      await context.auctions.placeBid(auction.id, { bidderId: 'ana', amountCents: 2_500 });
      return context.auctions.placeBid(auction.id, { bidderId: 'ben', amountCents: 2_500 });
    },
  ));

  cases.push(await runCase(
    {
      caseId: 'exactly-one-winner',
      title: 'Exactly one buyer wins',
      expectation: 'After four bidders contend and the auction closes, there must be exactly one winning order, and it must belong to the highest bidder.',
    },
    async () => {
      const context = scripted();
      const auction = await startOne(context);
      for (const [bidderId, amountCents] of [['ana', 2_400], ['ben', 2_600], ['cleo', 2_900], ['dev', 3_100]] as const) {
        await context.auctions.placeBid(auction.id, { bidderId, amountCents });
      }
      const closed = await context.auctions.closeAuction(auction.id);
      const order = closed.winnerOrder;
      const correct = Boolean(order) && order?.bidderId === 'dev' && order?.unitPriceCents === 3_100 && closed.status === 'closed';
      return {
        passed: correct,
        observed: order
          ? `${order.bidderId} won 1 unit at ${centsToDollars(order.unitPriceCents)}.`
          : 'The auction closed without producing a winning order.',
        evidence: {
          winner: order?.bidderId ?? 'none',
          price: order ? centsToDollars(order.unitPriceCents) : 'n/a',
          bidsPlaced: closed.bids.length,
          status: closed.status,
        },
      };
    },
  ));

  cases.push(await runCase(
    {
      caseId: 'multi-unit-total',
      title: 'A multi-unit win is charged for every unit',
      expectation: 'When two units are auctioned together, the winning order must total the unit price times two — not a single unit.',
    },
    async () => {
      const context = scripted();
      const auction = await startOne(context, 2);
      await context.auctions.placeBid(auction.id, { bidderId: 'ana', amountCents: 2_500 });
      const closed = await context.auctions.closeAuction(auction.id);
      const order = closed.winnerOrder;
      const correct = order?.quantity === 2 && order?.totalCents === 5_000;
      return {
        passed: correct,
        observed: order
          ? `${order.quantity} units at ${centsToDollars(order.unitPriceCents)} = ${centsToDollars(order.totalCents)}.`
          : 'No winning order was produced.',
        evidence: {
          quantity: order?.quantity ?? 0,
          unitPrice: order ? centsToDollars(order.unitPriceCents) : 'n/a',
          total: order ? centsToDollars(order.totalCents) : 'n/a',
        },
      };
    },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'bid-after-close-refused',
      title: 'A bid after the hammer is refused',
      expectation: 'Once the auction is closed, a late bid must be refused rather than reopening a settled sale.',
    },
    async () => {
      const context = scripted();
      const auction = await startOne(context);
      await context.auctions.placeBid(auction.id, { bidderId: 'ana', amountCents: 2_500 });
      await context.auctions.closeAuction(auction.id);
      return context.auctions.placeBid(auction.id, { bidderId: 'sniper', amountCents: 9_900 });
    },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'snipe-after-timer-refused',
      title: 'The clock is final — a bid after time is refused',
      expectation: 'A bid arriving after the auction\'s end time must be refused: the auction closes itself on the clock, without anyone pressing a button.',
    },
    async () => {
      const context = scripted();
      // The service reads the wall clock directly, so this case waits out a real
      // one-second auction rather than pretending to. It is the only slow case
      // here, and it is the one a reviewer is most likely to try by hand.
      const auction = await startOne(context, 1, 1);
      await context.auctions.placeBid(auction.id, { bidderId: 'ana', amountCents: 2_500 });
      await sleep(1_150);
      return context.auctions.placeBid(auction.id, { bidderId: 'sniper', amountCents: 9_900 });
    },
  ));

  cases.push(await runCase(
    {
      caseId: 'unsold-releases-stock',
      title: 'An auction nobody bids on gives the unit back',
      expectation: 'If no one bids, the held unit must be released back to sellable stock instead of staying locked away for the rest of the event.',
    },
    async () => {
      const context = scripted();
      const auction = await startOne(context);
      await context.auctions.closeAuction(auction.id);
      const snapshot = await context.inventory.get(PRODUCT);
      const released = snapshot?.availableQty === STOCK && snapshot?.reservedQty === 0;
      return {
        passed: released,
        observed: released
          ? `All ${STOCK} units are sellable again.`
          : `Expected ${STOCK} available, saw available=${snapshot?.availableQty} reserved=${snapshot?.reservedQty}.`,
        evidence: { available: snapshot?.availableQty ?? -1, reserved: snapshot?.reservedQty ?? -1 },
      };
    },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'second-auction-refused',
      title: 'Two auctions cannot run at once',
      expectation: 'Starting a second auction while one is live must be refused, so the room is never bidding on two things at the same time.',
    },
    async () => {
      const context = scripted();
      await startOne(context);
      return startOne(context);
    },
  ));

  cases.push(await expectRefusal(
    {
      caseId: 'auction-beyond-stock-refused',
      title: 'You cannot auction stock you do not have',
      expectation: `Opening an auction for 5 units when only ${STOCK} are verified must be refused instead of overselling the room.`,
    },
    async () => {
      const context = scripted();
      return startOne(context, 5);
    },
  ));

  return buildRehearsalReport({
    kind: 'auction',
    title: 'Live auction',
    cases,
    startedMs,
    now,
  });
}
