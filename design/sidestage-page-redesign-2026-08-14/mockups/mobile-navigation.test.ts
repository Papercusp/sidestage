import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const mockupDir = dirname(fileURLToPath(import.meta.url));

function readMockup(name: string): string {
  return readFileSync(join(mockupDir, name), 'utf8');
}

function mobileLinks(name: string): Array<{ href: string; label: string }> {
  const html = readMockup(name);
  const nav = html.match(/<nav class="primary-nav mobile-primary-nav"[\s\S]*?<\/nav>/)?.[0];

  expect(nav, `${name} must define the D-007 mobile navigation`).toBeDefined();

  return [...(nav ?? '').matchAll(/<a class="nav-link"(?: aria-current="page")? href="([^"]+)">([^<]+)<\/a>/g)].map(
    ([, href, label]) => ({ href, label }),
  );
}

describe('D-007 mobile navigation', () => {
  it.each(['buyer.html', 'orders.html'])('%s exposes exactly Buyer and Orders', (name) => {
    expect(mobileLinks(name)).toEqual([
      { href: 'buyer.html', label: 'Buyer' },
      { href: 'orders.html', label: 'Orders' },
    ]);
  });

  it('switches to the two-tab navigation below the 760px breakpoint used by the 390px guard', () => {
    const css = readMockup('shared.css');
    const breakpoint = css.indexOf('@media (max-width: 760px)');

    expect(breakpoint).toBeGreaterThan(-1);
    expect(css.slice(0, breakpoint)).toMatch(/\.mobile-primary-nav\s*{\s*display:\s*none;\s*}/);

    const mobileCss = css.slice(breakpoint);
    expect(mobileCss).toMatch(/\.desktop-primary-nav\s*{\s*display:\s*none;\s*}/);
    expect(mobileCss).toMatch(/\.mobile-primary-nav\s*{[^}]*display:\s*flex;/);
  });
});
