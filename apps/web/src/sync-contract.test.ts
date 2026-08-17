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
  // ChannelGuide's one timer advances scheduled-event countdown copy; the
  // directory itself arrives through useSyncQuery('events.guide').
  'events/ChannelGuide.tsx': { 'polling-timer': 1 },
  // The ONE stage-clock pulse (D-003), and the reason this entry is here rather
  // than on the two surfaces that render it: the Studio dock panel and the
  // Lineup timeline each used to own an identical 1s timer, so the same elapsed
  // second could paint on one up to a second before the other. Both now read the
  // provider's single pulse. It reads NO server state — it only re-renders the
  // pace the shared StageLog already holds — so it is the same permanently
  // valid local-clock exception as AuctionPanel above.
  //
  // This is a CEILING of one for the whole app's stage clock. A second entry
  // reappearing on RunOfShowPanel.tsx or EventManager.tsx means a surface has
  // re-grown its own timer, which is the drift D-003 exists to prevent.
  'seller/stage-clock.tsx': { 'polling-timer': 1 },
  'ConfigTab.tsx': { fetch: 1 },
  'CopilotPanel.tsx': { fetch: 1 },
  // One shared transport remains for named chat mutation REST fallbacks. Chat
  // components themselves are forbidden from owning direct fetch paths.
  'chat-api.ts': { fetch: 1 },
  'auction.ts': { fetch: 1 },
  'buyer-checkout-api.ts': { fetch: 1 },
  'catalog.ts': { fetch: 2 },
  'events/api.ts': { fetch: 1 },
  'judge.ts': { fetch: 1 },
  'rehearsals.ts': { fetch: 1, 'event-stream': 1 },
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
    const seller = readFileSync(path.join(sourceRoot, 'SellerTab.tsx'), 'utf8');
    const transcription = readFileSync(path.join(sourceRoot, 'transcription.ts'), 'utf8');
    const eventManager = readFileSync(path.join(sourceRoot, 'events/EventManager.tsx'), 'utf8');
    const runOfShow = readFileSync(path.join(sourceRoot, 'seller/RunOfShowPanel.tsx'), 'utf8');
    const runOfShowPlanner = readFileSync(path.join(sourceRoot, 'seller/RunOfShowPlannerPanel.tsx'), 'utf8');
    const inventoryPanel = readFileSync(path.join(sourceRoot, 'InventoryPanel.tsx'), 'utf8');
    const inventoryApi = readFileSync(path.join(sourceRoot, 'inventory-api.ts'), 'utf8');
    const app = readFileSync(path.join(sourceRoot, 'App.tsx'), 'utf8');

    expect(checkout).toContain("queryName: 'cart.byId'");
    for (const mutation of [
      'cart.holdProduct',
      'cart.setQuantity',
      'cart.removeItem',
      'shipping.rates',
      'checkout.createSession',
    ]) {
      expect(checkout, `BuyerCheckout must route ${mutation} through useSyncMutate`).toContain(`'${mutation}'`);
    }
    expect(checkout).not.toContain('checkout.confirmPayment');
    expect(checkout).not.toContain('Square');

    expect(copilot).toContain("queryName: 'event.copilot.proposals'");
    for (const mutation of [
      'copilot.createTurn',
      'copilot.approve',
      'copilot.skip',
      'copilot.confirmAction',
    ]) {
      expect(copilot, `Copilot must route ${mutation} through useSyncMutate`).toContain(`'${mutation}'`);
    }
    expect(copilot).not.toContain('useBuyerCheckout');
    expect(copilot).not.toContain('useEventChatSender');
    expect(copilot).not.toContain("'/cart/items'");
    expect(copilot).not.toContain("'/checkout/sessions'");
    expect(copilot).toContain('[DEMO_PRINCIPAL_HEADER]: principal');
    expect(chat).toContain("'chat.sendMessage'");
    expect(chat).toContain("'chat.touchPresence'");
    expect(chat).toContain("'chat.leavePresence'");
    expect(chat).toContain('const sendMessage = useEventChatSender({ eventId, apiBaseUrl })');
    expect(chat).not.toMatch(/\bfetch\s*\(/);
    expect(chat).toContain('sellerPrivateRequestHeaders(principal');
    expect(seller).toContain("'chat.addTranscriptMoment'");
    expect(seller).toContain('useTranscriptMomentRecorder({');
    expect(seller).not.toContain('readSellerAuctionToken');
    expect(seller).toContain('headers: sellerPrivateRequestHeaders(principal)');
    expect(seller).not.toContain('VITE_DEEPGRAM_TOKEN');
    expect(seller).not.toMatch(/\bfetch\s*\(/);
    expect(inventoryPanel).toContain("'inventory.save'");
    expect(inventoryPanel).toContain("'inventory.onboard'");
    expect(inventoryPanel).toContain('useSyncMutate');
    expect(inventoryApi).toContain('requestJson');
    expect(inventoryApi).not.toMatch(/\bfetch\s*\(/);
    expect(transcription).toContain('const socket = factory(buildDeepgramUrl(');
    expect(transcription).not.toContain('VITE_DEEPGRAM_TOKEN');
    expect(transcription).toContain('[DEMO_PRINCIPAL_HEADER]: principal');
    expect(eventManager).toContain('startingPriceCents, apiBaseUrl, demoPrincipal');
    expect(eventManager).not.toContain('sellerAuctionToken');
    expect(runOfShow).toContain("queryName: 'event.runOfShow'");
    expect(runOfShow).toContain("queryName: 'event.actions.items'");
    expect(runOfShow).toContain("queryName: 'event.auction.active'");
    expect(runOfShow).toContain("useSyncMutate<StartNextAuction, SellerAuction>('auction.start'");
    expect(runOfShow).not.toContain('readSellerAuctionToken');
    expect(runOfShow).not.toContain('fetchSellerEvent');
    expect(runOfShowPlanner).toContain('saveRunOfShowPlan(eventId, entries, apiBaseUrl, principal)');

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

  it('keeps auction and build history on one live-query authority with retry only on errors', () => {
    const auction = readFileSync(path.join(sourceRoot, 'AuctionPanel.tsx'), 'utf8');
    const buildHistory = readFileSync(path.join(sourceRoot, 'BuildHistoryTab.tsx'), 'utf8');

    expect(auction).toContain("queryName: 'event.auction.active'");
    expect(auction).not.toContain('fetchActiveAuction');
    expect(auction).not.toContain('setAuction(');
    expect(auction).not.toContain('refreshFromRest');
    expect(auction).toContain('Try again');

    expect(buildHistory).toContain("queryName: 'build.history'");
    expect(buildHistory).not.toContain('Refresh history');
    expect(buildHistory).toContain('Try again');
  });

  it('routes rehearsal reads and commands through named sync seams while preserving measurement transports', () => {
    const testTab = readFileSync(path.join(sourceRoot, 'TestTab.tsx'), 'utf8');
    const systemTests = readFileSync(path.join(sourceRoot, 'SystemTestsTab.tsx'), 'utf8');
    const rehearsals = readFileSync(path.join(sourceRoot, 'rehearsals.ts'), 'utf8');

    expect(testTab).toContain("queryName: 'rehearsal.preflight'");
    expect(testTab).toContain("'rehearsal.run'");
    expect(testTab).toContain("'rehearsal.runAll'");
    expect(systemTests).toContain("'rehearsal.run'");
    expect(testTab).not.toContain('fetchPreflight');
    expect(rehearsals).not.toContain('fetchPreflight');

    // These direct paths are the probes themselves, not server-state bypasses.
    expect(rehearsals).toContain('/rehearsals/client-realtime/');
    expect(rehearsals).toContain('/rehearsals/client-clock');
    expect(rehearsals).toContain('createResilientEventSource({');
    expect(rehearsals).toContain('mediaDevices.getUserMedia');
  });
});
