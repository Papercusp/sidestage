import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('public landing-page performance policy', () => {
  it('keeps non-landing workspaces behind route-level dynamic imports', () => {
    const source = read('./App.tsx');
    const main = read('./main.tsx');
    for (const component of [
      'ArchitectureTab',
      'BuildHistoryTab',
      'OrdersTab',
      'SellerTab',
      'SystemTestsTab',
    ]) {
      expect(source).not.toMatch(new RegExp(`^import \\{ ${component} \\} from`, 'm'));
      expect(source).toContain(`import('./${component}')`);
    }
    expect(source).not.toContain("from './TestTab'");
    expect(main).not.toMatch(/^import \{ ActiveNowComparison/m);
    expect(main).toContain("import('./ActiveNowComparison')");
  });

  it('loads seller inventory only inside the Studio route', () => {
    const source = read('./App.tsx');
    const sellerRoute = source.slice(
      source.indexOf('function SellerRoute('),
      source.indexOf('function RouteLoading('),
    );
    const app = source.slice(source.indexOf('export function App()'));
    expect(sellerRoute).toContain('useSellerCatalog()');
    expect(app).not.toContain('useSellerCatalog()');
  });

  it('keeps Stripe out of the landing bundle and defers its remote script until payment', () => {
    const checkout = read('./BuyerCheckout.tsx');
    const stripe = read('./StripePaymentForm.tsx');
    expect(checkout).not.toMatch(/^import \\{ StripePaymentForm \\}/m);
    expect(checkout).toContain("import('./StripePaymentForm')");
    expect(stripe).toContain("from '@stripe/stripe-js/pure'");
    expect(stripe).not.toMatch(
      /^import \{[^}]*loadStripe[^}]*\} from '@stripe\/stripe-js';/m,
    );
  });

  it('loads closed cart and Scout drawer stacks only after buyer intent', () => {
    const checkout = read('./BuyerCheckout.tsx');
    expect(checkout).not.toMatch(/^import \{ BuyerCartDrawer \}/m);
    expect(checkout).not.toMatch(/^import \{ BuyerScoutDrawer \}/m);
    expect(checkout).toContain("import('./BuyerCartDrawer')");
    expect(checkout).toContain("import('./BuyerScoutDrawer')");
    expect(checkout).toContain("scoutLoadState === 'idle'");
    expect(checkout).toContain('cartOpen || contextValue.heldItemCount > 0');
    expect(checkout).toContain('<BuyerScoutLoadButton onClick={requestScout} />');
  });

  it('keeps an idle transcript overlay out of the buyer critical path', () => {
    const buyer = read('./BuyerTab.tsx');
    expect(buyer).not.toMatch(/^import \{[^}]*VideoEngagementOverlay[^}]*\} from/m);
    expect(buyer).toContain("import('./VideoEngagementOverlay')");
    expect(buyer).toContain("transcript.segments.length > 0 || transcript.error || streamState === 'live'");
    expect(buyer).toContain("from './buyer-transcript-presentation'");
  });

  it('defers buyer chat code and presence work until its panel is visible or requested', () => {
    const buyer = read('./BuyerTab.tsx');
    expect(buyer).not.toMatch(/^import \{ EventChat \} from/m);
    expect(buyer).toContain("import('./EventChat')");
    expect(buyer).toContain('intersectionRatio >= 0.75');
    expect(buyer).toContain("ready ? 'Loading live chat…' : 'Load live chat'");
  });

  it('keeps lazy workspace CSS out of the landing render-blocking stylesheet', () => {
    const entryStyles = read('./styles.css');
    const eventChat = read('./EventChat.tsx');
    const copilot = read('./CopilotPanel.tsx');
    const eventChatStyles = read('./event-chat.css');
    const copilotStyles = read('./copilot-panel.css');
    const testStyles = read('./test-workbench.css');

    expect(Buffer.byteLength(entryStyles)).toBeLessThanOrEqual(50_000);
    for (const selector of [
      '.event-chat-heading',
      '.copilot-panel',
      '.load-simulator-panel',
      '.judge-panel',
      '.rehearsal-panel',
    ]) {
      expect(entryStyles).not.toContain(selector);
    }
    expect(eventChat).toContain("import './event-chat.css'");
    expect(copilot).toContain("import './copilot-panel.css'");
    expect(eventChatStyles).toContain('.event-chat-heading');
    expect(copilotStyles).toContain('.copilot-panel');
    expect(testStyles).toContain('.load-simulator-panel');
    expect(testStyles).toContain('.judge-panel');
    expect(testStyles).toContain('.rehearsal-panel');
  });

  it('does not ship the WebSocket-only Zero registry in the fixed-SSE entry', () => {
    const main = read('./main.tsx');
    const seller = read('./SellerTab.tsx');
    expect(main).toContain('syncType="SSE"');
    expect(main).not.toContain("from '@papercusp/sidestage-zero'");
    expect(main).not.toContain("from './grid-theme-bridge'");
    expect(main).not.toContain('applyGridTheme()');
    expect(seller).toContain("import { applyGridTheme } from './grid-theme-bridge'");
    expect(seller).toContain('applyGridTheme()');
    for (const prop of ['schema', 'queries', 'mutators']) {
      expect(main).not.toMatch(new RegExp('\\s' + prop + '=\\{'));
    }
  });

  it('does not lay out closed drawer bodies on the landing page', () => {
    const scout = read('./BuyerScoutDrawer.tsx');
    const cart = read('./BuyerCartDrawer.tsx');
    expect(scout).toContain('{({ close, otherOpen, open }) => open ? (');
    expect(cart).toContain('{open ? <BuyerCartPanel {...panel} /> : null}');
  });

  it('lets the browser skip below-fold buyer layout without hiding it', () => {
    const styles = read('./BuyerTab.css');
    expect(styles).toMatch(
      /\.buyer-current-offer-slot\s*\{[^}]*content-visibility:\s*auto;[^}]*contain-intrinsic-size:/,
    );
    expect(styles).toMatch(
      /\.buyer-room-context\s*\{[^}]*content-visibility:\s*auto;[^}]*contain-intrinsic-size:/,
    );
    expect(styles).toMatch(
      /\.buyer-lower-grid\s*\{[^}]*content-visibility:\s*auto;[^}]*contain-intrinsic-size:/,
    );
  });

  it('ships crawl metadata and the measured contrast repairs', () => {
    const html = read('../index.html');
    const robots = read('../public/robots.txt');
    const styles = read('./styles.css');
    expect(html).toMatch(/<meta name="description" content="[^"]+" \/>/);
    expect(robots).toBe('User-agent: *\nAllow: /\n');
    expect(styles).toMatch(/\.app-badge-hint\s*\{[^}]*opacity:\s*1;/);
    expect(styles).toMatch(/\.papercusp-tagline strong\s*\{[^}]*color:\s*#11786f;/i);
  });
});
