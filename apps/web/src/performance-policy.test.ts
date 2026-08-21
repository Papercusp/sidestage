import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string) =>
  readFileSync(new URL(relativePath, import.meta.url), 'utf8');

describe('public landing-page performance policy', () => {
  it('keeps non-landing workspaces behind route-level dynamic imports', () => {
    const source = read('./App.tsx');
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
