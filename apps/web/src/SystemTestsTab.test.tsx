import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SYSTEM_TEST_SUITE_GROUPS, SystemTestsTab } from './SystemTestsTab';

describe('SystemTestsTab', () => {
  it('contains only event-independent capability, load, and judge suites', () => {
    expect(SYSTEM_TEST_SUITE_GROUPS.flatMap((group) => group.suites.map((suite) => suite.id))).toEqual([
      'actions',
      'auction',
      'checkout',
      'injection',
      'load',
      'judge',
    ]);
  });

  it('states the isolation contract and exposes no event-scoped controls', () => {
    const markup = renderToStaticMarkup(<SystemTestsTab />);

    expect(markup).toContain('Synthetic system verification');
    expect(markup).toContain('Isolated by design');
    expect(markup).toContain('do not use the live event, real buyers, real orders, or reserved inventory');
    expect(markup).toContain('synthetic / no-event');
    expect(markup).toContain('Guarded actions');
    expect(markup).toContain('Load simulation');
    expect(markup).toContain('Reply judge');
    expect(markup).not.toContain('Event under test');
    expect(markup).not.toContain('Run event preflight');
    expect(markup).not.toContain('Ready to go live');
  });
});
