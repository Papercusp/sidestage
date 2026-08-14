import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type AccessKind = 'fetch' | 'event-stream' | 'polling-timer';

interface AccessFinding {
  file: string;
  kind: AccessKind;
  count: number;
}

const sourceRoot = fileURLToPath(new URL('.', import.meta.url));

const accessPatterns: Record<AccessKind, RegExp> = {
  fetch: /\bfetch\s*\(/g,
  'event-stream': /\b(?:(?:new\s+(?:globalThis\.)?)?EventSource|createResilientEventSource)\s*\(/g,
  'polling-timer': /\b(?:setInterval\s*\(|refetchInterval\s*:)/g,
};

/**
 * Current migration debt, expressed as ceilings so deleting a direct access
 * passes immediately. P-007..P-013 remove these entries as each surface moves
 * behind @papercusp/sync. Unknown files never get an implicit allowance.
 * AuctionPanel's one timer advances a local countdown clock; it does not read
 * server state, so that explicit exception remains valid after migration.
 */
const legacyAccessBudget = {
  'AuctionPanel.tsx': { 'polling-timer': 1 },
  // RunOfShowPanel's one timer ticks the on-stage elapsed clock; it reads no
  // server state (the plan arrives via useSyncQuery('event.runOfShow')), so it
  // is the same permanently-valid local-clock exception as AuctionPanel above.
  'seller/RunOfShowPanel.tsx': { 'polling-timer': 1 },
  'ConfigTab.tsx': { fetch: 1 },
  'CopilotPanel.tsx': { fetch: 1 },
  'EventChat.tsx': { fetch: 2 },
  'SellerTab.tsx': { fetch: 1 },
  'auction.ts': { fetch: 1 },
  'buyer-checkout-api.ts': { fetch: 1 },
  'catalog.ts': { fetch: 2 },
  'events/api.ts': { fetch: 1 },
  'judge.ts': { fetch: 1 },
  'rehearsals.ts': { fetch: 2, 'event-stream': 1 },
} satisfies Record<string, Partial<Record<AccessKind, number>>>;

function listProductionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return listProductionSources(absolute);
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) return [];
    if (/\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];
    return [absolute];
  });
}

function scanDirectServerAccess(): AccessFinding[] {
  return listProductionSources(sourceRoot).flatMap((absolute) => {
    const file = path.relative(sourceRoot, absolute).split(path.sep).join('/');
    const source = readFileSync(absolute, 'utf8');
    return (Object.entries(accessPatterns) as Array<[AccessKind, RegExp]>).flatMap(([kind, pattern]) => {
      pattern.lastIndex = 0;
      const count = Array.from(source.matchAll(pattern)).length;
      return count > 0 ? [{ file, kind, count }] : [];
    });
  });
}

describe('SideStage web sync contract', () => {
  it('rejects new direct server-state paths outside the named migration budget', () => {
    const findings = scanDirectServerAccess();
    const unknown = findings.filter(({ file, kind }) => {
      const budget = legacyAccessBudget[file as keyof typeof legacyAccessBudget] as Partial<Record<AccessKind, number>> | undefined;
      return budget?.[kind] === undefined;
    });

    expect(unknown, `Move new server-state access behind @papercusp/sync: ${JSON.stringify(unknown)}`).toEqual([]);

    for (const [file, budget] of Object.entries(legacyAccessBudget)) {
      for (const [kind, maximum] of Object.entries(budget) as Array<[AccessKind, number]>) {
        const actual = findings.find((finding) => finding.file === file && finding.kind === kind)?.count ?? 0;
        expect(actual, `${file} has ${actual} ${kind} paths; legacy ceiling is ${maximum}`).toBeLessThanOrEqual(maximum);
      }
    }
  });

  it('keeps checkout, copilot, and chat on one app-wide ownership seam', () => {
    const checkout = readFileSync(path.join(sourceRoot, 'BuyerCheckout.tsx'), 'utf8');
    const copilot = readFileSync(path.join(sourceRoot, 'CopilotPanel.tsx'), 'utf8');
    const chat = readFileSync(path.join(sourceRoot, 'EventChat.tsx'), 'utf8');
    const app = readFileSync(path.join(sourceRoot, 'App.tsx'), 'utf8');

    expect(checkout).toContain("queryName: 'cart.byId'");
    for (const mutation of [
      'cart.holdProduct',
      'cart.setQuantity',
      'cart.removeItem',
      'shipping.rates',
      'checkout.createSession',
      'checkout.confirmPayment',
    ]) {
      expect(checkout, `BuyerCheckout must route ${mutation} through useSyncMutate`).toContain(`'${mutation}'`);
    }

    expect(copilot).toContain('useBuyerCheckout()');
    expect(copilot).toContain('useEventChatSender({ eventId, apiBaseUrl })');
    expect(copilot).not.toContain("'/cart/items'");
    expect(copilot).not.toContain("'/checkout/sessions'");
    expect(chat).toContain("'chat.sendMessage'");
    expect(chat).toContain('const sendMessage = useEventChatSender({ eventId, apiBaseUrl })');

    const provider = app.indexOf('<BuyerCheckoutProvider');
    expect(provider).toBeGreaterThan(-1);
    expect(provider).toBeLessThan(app.indexOf("{tab === 'buyer'"));
    expect(provider).toBeLessThan(app.indexOf("{tab === 'seller'"));
  });

  it('keeps seller pricing history on the event/product-scoped live query', () => {
    const pricingHistory = readFileSync(path.join(sourceRoot, 'seller/PricingHistoryPanel.tsx'), 'utf8');
    expect(pricingHistory).toContain("queryName: 'event.pricingHistory'");
    expect(pricingHistory).toContain('args: { eventId, productId }');
    expect(pricingHistory).not.toMatch(/\bfetch\s*\(/);
  });
});
