import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { EventManager } from './EventManager';
import { DEMO_EVENTS } from './events';

describe('EventManager', () => {
  it('renders event list/detail controls from the seller event model', () => {
    const markup = renderToStaticMarkup(<EventManager initialEvents={DEMO_EVENTS} />);

    expect(markup).toContain('Run every drop from one view.');
    expect(markup).toContain('Sunday vintage drop');
    expect(markup).toContain('Add catalog items');
    expect(markup).toContain('Markdown guardrail: 20% maximum');
    expect(markup).toContain('Event price for Barista Pro Espresso Machine');
  });

  it('renders an empty detail state when there are no events', () => {
    const markup = renderToStaticMarkup(<EventManager initialEvents={[]} />);

    expect(markup).toContain('Create an event to start building your live floor.');
    expect(markup).toContain('0 scheduled spaces');
  });
});
