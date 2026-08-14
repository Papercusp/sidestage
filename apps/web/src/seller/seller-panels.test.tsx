import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OFFLINE_FIXTURE } from '../catalog';
import { variantToSellerProduct } from '../seller-products';
import { OnDeckPanel } from './OnDeckPanel';
import { StageStatusPanel } from './StageStatusPanel';
import type { StageStatusPanelProps } from './StageStatusPanel';

const noop = () => undefined;

function stageProps(overrides: Partial<StageStatusPanelProps> = {}): StageStatusPanelProps {
  return {
    eventTitle: 'Vintage drop night',
    eventId: 'demo-room',
    onEventIdChange: noop,
    roomEventId: null,
    streamState: 'idle',
    streamError: null,
    videoRef: null,
    isSessionActive: false,
    onStartEvent: noop,
    onEndEvent: noop,
    onShareRoom: noop,
    shareDisabled: true,
    copyState: 'idle',
    ...overrides,
  };
}

/**
 * P-008 pins the extracted seller sections' markup + aria contract. These
 * panels were lifted verbatim out of SellerTab so they can be mounted as
 * standalone dock panels (P-009); the ids and landmark wiring below are what
 * the seller tab's accessibility relies on, so a change here is a regression
 * unless it is a deliberate one.
 */
describe('StageStatusPanel', () => {
  it('keeps the stage-primary landmark, its aria wiring, and the room-id field contract', () => {
    const markup = renderToStaticMarkup(<StageStatusPanel {...stageProps()} />);
    expect(markup).toContain('<section class="stage-panel stage-primary" aria-labelledby="stage-status-title">');
    expect(markup).toContain('<h2 id="stage-status-title">Vintage drop night</h2>');
    expect(markup).toContain('<label class="field-label" for="seller-event-id">Event room id</label>');
    expect(markup).toContain('aria-describedby="seller-event-help"');
    expect(markup).toContain('<p class="field-help" id="seller-event-help">');
    expect(markup).toContain('aria-label="Seller camera preview"');
    expect(markup).toContain('<span class="live-badge">room not started</span>');
  });

  it('labels each stream state and offers Start before a session exists', () => {
    expect(renderToStaticMarkup(<StageStatusPanel {...stageProps()} />)).toContain('Preview ready');
    expect(renderToStaticMarkup(<StageStatusPanel {...stageProps({ streamState: 'live' })} />))
      .toContain('Live now');
    expect(renderToStaticMarkup(<StageStatusPanel {...stageProps({ streamState: 'error', streamError: 'No camera' })} />))
      .toContain('No camera');

    const idle = renderToStaticMarkup(<StageStatusPanel {...stageProps()} />);
    expect(idle).toContain('>Start event</button>');
    expect(idle).not.toContain('>End event</button>');

    const connecting = renderToStaticMarkup(<StageStatusPanel {...stageProps({ streamState: 'connecting' })} />);
    expect(connecting).toContain('Starting…');
    expect(connecting).toContain('disabled=""');
  });

  it('swaps to End event and enables sharing once a room is live', () => {
    const markup = renderToStaticMarkup(
      <StageStatusPanel
        {...stageProps({
          isSessionActive: true,
          streamState: 'live',
          roomEventId: 'demo-room',
          shareDisabled: false,
          copyState: 'copied',
        })}
      />,
    );
    expect(markup).toContain('>End event</button>');
    expect(markup).not.toContain('>Start event</button>');
    expect(markup).toContain('<span class="live-badge">demo-room</span>');
    expect(markup).toContain('Link copied');
    expect(markup).toContain('Your camera and microphone are live.');
  });

  it('reports a failed copy without losing the share control', () => {
    const markup = renderToStaticMarkup(
      <StageStatusPanel {...stageProps({ shareDisabled: false, copyState: 'failed' })} />,
    );
    expect(markup).toContain('Copy failed');
  });
});

describe('OnDeckPanel', () => {
  it('renders the staged product with the on-deck heading', () => {
    const product = variantToSellerProduct(OFFLINE_FIXTURE[0], 0);
    const markup = renderToStaticMarkup(<OnDeckPanel selectedProduct={product} />);
    expect(markup).toContain('<section class="stage-panel" aria-labelledby="on-deck-title">');
    expect(markup).toContain(`<h3 id="on-deck-title">${product.name}</h3>`);
    expect(markup).toContain(`mini-product-mark tone-${product.tone}`);
    expect(markup).toContain(`${product.price} · ${product.stockLabel}`);
    expect(markup).not.toContain('empty-state');
  });

  it('keeps the on-deck heading id in the empty state so the landmark stays labelled', () => {
    const markup = renderToStaticMarkup(<OnDeckPanel selectedProduct={null} />);
    expect(markup).toContain('<section class="stage-panel" aria-labelledby="on-deck-title">');
    expect(markup).toContain('<h3 id="on-deck-title">Choose a product</h3>');
    expect(markup).toContain('class="empty-state"');
    expect(markup).not.toContain('on-deck-product');
  });
});
