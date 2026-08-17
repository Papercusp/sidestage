import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Stripe's body-level "developer tools" frame intercepts clicks aimed at the
 * checkout drawer (EI-20606986502740055). The mitigation is a CSS rule, and the
 * risk in that rule is SCOPE, not syntax: matching too broadly also disables the
 * 3D Secure challenge frame, which Stripe appends the same way and which the
 * buyer must be able to click to authenticate.
 *
 * Vitest does not apply imported stylesheets, so asserting getComputedStyle
 * would prove nothing. Instead this reads the selector out of the shipped CSS
 * and evaluates it with the DOM's own selector engine — that tests what the rule
 * actually MATCHES, and it fails if someone widens the selector later.
 */

const cssPath = fileURLToPath(new URL('./buyer-checkout.css', import.meta.url));

/** Selectors of every rule in the stylesheet whose block disables pointer events. */
function pointerEventsNoneSelectors(css: string): string[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors: string[] = [];
  for (const [, selector, block] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (/pointer-events\s*:\s*none/i.test(block)) selectors.push(selector.trim());
  }
  return selectors;
}

function iframeIn(parent: HTMLElement, attrs: Record<string, string>): HTMLIFrameElement {
  const frame = document.createElement('iframe');
  for (const [key, value] of Object.entries(attrs)) frame.setAttribute(key, value);
  parent.appendChild(frame);
  return frame;
}

describe('Stripe overlay frames are neutralised without breaking payment frames', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const css = readFileSync(cssPath, 'utf8');
  const selectors = pointerEventsNoneSelectors(css);
  const selector = selectors.join(', ');

  it('ships exactly one pointer-events:none rule for the checkout surface', () => {
    expect(selectors).toHaveLength(1);
    expect(selector).toMatch(/iframe/);
  });

  it('disables the developer-tools overlay however Stripe labels it', () => {
    // The frame is identified by name in some Stripe builds and by title in
    // others; either alone must be enough to neutralise it.
    const byName = iframeIn(document.body, { name: '__privateStripeDeveloperToolsFrame' });
    const byTitle = iframeIn(document.body, { title: 'Stripe developer tools frame' });

    expect(byName.matches(selector)).toBe(true);
    expect(byTitle.matches(selector)).toBe(true);
  });

  it('leaves the 3D Secure challenge frame clickable', () => {
    // Appended to <body> exactly like the dev-tools overlay. If the selector
    // ever widens to all body-level Stripe frames this fails — and it should,
    // because a non-clickable challenge frame makes the order unpayable.
    const challenge = iframeIn(document.body, {
      name: '__privateStripeFrame1',
      title: 'Secure authentication frame',
    });

    expect(challenge.matches(selector)).toBe(false);
  });

  it('leaves the mounted PaymentElement frame clickable', () => {
    const host = document.createElement('div');
    host.className = 'buyer-stripe-element';
    document.body.appendChild(host);
    const paymentElement = iframeIn(host, {
      name: '__privateStripeFrame2',
      title: 'Secure payment input frame',
    });

    expect(paymentElement.matches(selector)).toBe(false);
  });

  it('does not disable pointer events on non-Stripe body iframes', () => {
    const unrelated = iframeIn(document.body, { name: 'video-embed', title: 'Auction stream' });

    expect(unrelated.matches(selector)).toBe(false);
  });
});
