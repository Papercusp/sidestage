/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import { productDescriptionText } from './product-description-text';
import { OFFLINE_FIXTURE, variantToBuyerProduct } from './catalog';

/**
 * EI-20491379430268439 reported the exact markup below reaching buyers as
 * literal text on Scout cards. These assert on the PROJECTED STRING rather than
 * on source text, so the guard cannot be satisfied by a comment that merely
 * describes the behaviour.
 */
describe('catalog description projection', () => {
  it('projects the markup reported in EI-20491379430268439 into readable prose', () => {
    const merchantHtml =
      '<p><b>Kyocera ECOSYS</b> mono laser printer.</p>'
      + '<ul><li>35 ppm</li><li>Duplex printing</li></ul>'
      + 'Refurbished by Merlin.<br><br>Ships boxed.';

    const projected = productDescriptionText(merchantHtml);

    expect(projected).toBe(
      'Kyocera ECOSYS mono laser printer. 35 ppm Duplex printing Refurbished by Merlin. Ships boxed.',
    );
    // The literal tags the customer saw must be gone, not merely escaped.
    for (const tag of ['<p>', '<b>', '<ul>', '<li>', '<br>']) {
      expect(projected).not.toContain(tag);
    }
  });

  it('keeps adjacent block tags from running words together', () => {
    expect(productDescriptionText('<li>Duplex</li><li>Wireless</li>')).toBe('Duplex Wireless');
    expect(productDescriptionText('One<br><br>Two')).toBe('One Two');
  });

  it('decodes entities and drops non-copy nodes', () => {
    expect(productDescriptionText('USB &amp; SAS<script>steal()</script>')).toBe('USB & SAS');
    expect(productDescriptionText('Ships&nbsp;boxed.')).toBe('Ships boxed.');
  });

  it('carries plain descriptions through untouched', () => {
    expect(productDescriptionText('Plain prose, no markup.')).toBe('Plain prose, no markup.');
    expect(productDescriptionText('  padded  ')).toBe('padded');
    expect(productDescriptionText('')).toBeUndefined();
    expect(productDescriptionText(undefined)).toBeUndefined();
    expect(productDescriptionText('<p>   </p>')).toBeUndefined();
  });

  it('projects at the catalog row->product boundary, so every render site inherits it', () => {
    const [variant] = OFFLINE_FIXTURE;
    const product = variantToBuyerProduct({
      ...variant,
      description: '<p><b>Espresso</b> machine.</p><ul><li>15 bar</li></ul>',
    });

    expect(product.description).toBe('Espresso machine. 15 bar');
  });
});
