import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OFFLINE_FIXTURE } from '../catalog';
import { variantToSellerProduct } from '../seller-products';
import { OnDeckPanel } from './OnDeckPanel';
import { StageStatusPanel } from './StageStatusPanel';
import type { StageStatusPanelProps } from './StageStatusPanel';
import { activeEventStatus } from './active-event-status';
import type { SellerEventRecord } from '../events/api';
import type { LiveTranscriptController } from '../use-live-transcript';

const noop = () => undefined;
const TRANSCRIPT_FIXTURE = {
  provider: 'web-speech',
  state: 'idle',
  finalSegments: [],
  interim: '',
  error: null,
  activeProduct: null,
  suggestedProduct: null,
  stageProduct: noop,
  dismissSuggestion: noop,
} satisfies LiveTranscriptController;

function stageProps(overrides: Partial<StageStatusPanelProps> = {}): StageStatusPanelProps {
  return {
    eventTitle: 'Vintage drop night',
    eventId: 'demo-room',
    onEventIdChange: noop,
    eventStatus: activeEventStatus('demo-room', [], true),
    roomEventId: null,
    streamState: 'idle',
    streamError: null,
    publishWarning: null,
    onPublishEvent: noop,
    publishing: false,
    videoRef: null,
    isSessionActive: false,
    onStartEvent: noop,
    onEndEvent: noop,
    chat: <p>Seller room chat</p>,
    transcript: TRANSCRIPT_FIXTURE,
    ...overrides,
  };
}

/** A seller-directory row, for driving the panel's lifecycle states. */
function ownedEvent(status: SellerEventRecord['status']): SellerEventRecord[] {
  return [{
    eventId: 'demo-room',
    title: 'Vintage drop night',
    sellerId: 'seller-1',
    sellerName: 'Avi',
    status,
    startsAt: null,
    endedAt: null,
  }];
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
    expect(markup).toContain('seller-video-engagement-overlay');
    expect(markup).toContain('class="video-engagement-chat-panel"');
    expect(markup).toContain('Seller room chat');
    expect(markup).toContain('Captions start with the event');
    expect(markup).toContain('>Transcript</button>');
  });

  it('never lets the camera pane call a live event "room not started" (WI-39839)', () => {
    // The wiring half of the fix, and the half a pure-function test cannot
    // reach: stageRoomBadgeLabel shipped correct-but-uncalled once already, so
    // this asserts through the rendered pane rather than the helper.
    const live = renderToStaticMarkup(
      <StageStatusPanel {...stageProps({ eventStatus: activeEventStatus('demo-room', ownedEvent('live'), false) })} />,
    );
    expect(live).toContain('<span class="live-badge">Live - your camera is not on</span>');
    expect(live).not.toContain('room not started');

    // The badge still reports the attached room id when this tab holds one.
    const attached = renderToStaticMarkup(
      <StageStatusPanel {...stageProps({
        eventStatus: activeEventStatus('demo-room', ownedEvent('live'), false),
        roomEventId: 'demo-room',
      })} />,
    );
    expect(attached).toContain('<span class="live-badge">demo-room</span>');
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

  it('swaps to End event without exposing a Share room action once a room is live', () => {
    const markup = renderToStaticMarkup(
      <StageStatusPanel
        {...stageProps({
          isSessionActive: true,
          streamState: 'live',
          roomEventId: 'demo-room',
        })}
      />,
    );
    expect(markup).toContain('>End event</button>');
    expect(markup).not.toContain('>Start event</button>');
    expect(markup).toContain('<span class="live-badge">demo-room</span>');
    expect(markup).not.toContain('Share room');
    expect(markup).toContain('Your camera and microphone are live.');
  });

  /**
   * WI-39718 — the console must never again let a seller infer buyer-visibility
   * from chrome alone. Before this, the markup below was IDENTICAL for a draft,
   * a live event, and a room id with no event behind it.
   */
  describe('lifecycle status cue', () => {
    it('marks a draft as invisible to buyers on the surface the seller is looking at', () => {
      const markup = renderToStaticMarkup(
        <StageStatusPanel {...stageProps({ eventStatus: activeEventStatus('demo-room', ownedEvent('draft'), false) })} />,
      );

      expect(markup).toContain('Draft - not visible to buyers');
      expect(markup).toContain('stage-event-status is-draft');
      // role=status so the verdict is announced when the directory resolves,
      // not only when someone happens to look.
      expect(markup).toContain('role="status"');
    });

    it('warns when the studio is pointed at a room the seller does not own', () => {
      const markup = renderToStaticMarkup(
        <StageStatusPanel {...stageProps({ eventStatus: activeEventStatus('demo-room', [], false) })} />,
      );

      expect(markup).toContain('Not one of your events');
      expect(markup).toContain('stage-event-status is-unlisted');
    });

    it('confirms buyer visibility once the event is live, and stops offering to start it', () => {
      // The owner's repro: 'potato' was already live and the tab still said
      // "Start event".
      const markup = renderToStaticMarkup(
        <StageStatusPanel {...stageProps({ eventStatus: activeEventStatus('demo-room', ownedEvent('live'), false) })} />,
      );

      expect(markup).toContain('Live - visible to buyers');
      expect(markup).toContain('>Go on camera</button>');
      expect(markup).not.toContain('>Start event</button>');
      expect(markup).toContain('does not restart the event');
    });

    it('keeps the start hint off every state that has not gone live', () => {
      const draft = renderToStaticMarkup(
        <StageStatusPanel {...stageProps({ eventStatus: activeEventStatus('demo-room', ownedEvent('draft'), false) })} />,
      );

      expect(draft).toContain('>Start event</button>');
      expect(draft).not.toContain('does not restart the event');
    });
  });

  /**
   * The loud half: "Start event" publishes first, so a failed publish is the
   * one state in which the camera is live and no buyer can reach the room. The
   * video preview looks identical either way, so the alert IS the signal.
   */
  describe('publish-on-start failure', () => {
    it('raises an alert with a one-click retry, without leaving the console', () => {
      const markup = renderToStaticMarkup(
        <StageStatusPanel {...stageProps({ publishWarning: "Buyers cannot find this room in What's on." })} />,
      );

      expect(markup).toContain('role="alert"');
      expect(markup).toContain("Buyers cannot find this room in What&#x27;s on.");
      expect(markup).toContain('>Publish to buyers</button>');
    });

    it('shows nothing at all when the publish landed', () => {
      const markup = renderToStaticMarkup(<StageStatusPanel {...stageProps()} />);

      expect(markup).not.toContain('role="alert"');
      expect(markup).not.toContain('Publish to buyers');
    });

    it('disables the retry while a publish is in flight', () => {
      const markup = renderToStaticMarkup(
        <StageStatusPanel {...stageProps({ publishWarning: 'Could not publish.', publishing: true })} />,
      );

      expect(markup).toContain('>Publishing…</button>');
      expect(markup).toContain('disabled=""');
    });
  });
});

describe('OnDeckPanel', () => {
  it('renders the staged product with the on-deck heading', () => {
    const product = variantToSellerProduct(OFFLINE_FIXTURE[0], 0);
    const markup = renderToStaticMarkup(<OnDeckPanel selectedProduct={product} eventId="demo-room" />);
    expect(markup).toContain('<section class="stage-panel" aria-labelledby="on-deck-title">');
    expect(markup).toContain(`<h3 id="on-deck-title">${product.name}</h3>`);
    expect(markup).toContain(`mini-product-mark tone-${product.tone}`);
    expect(markup).toContain(`${product.price} · ${product.stockLabel}`);
    expect(markup).not.toContain('empty-state');
  });

  it('keeps the on-deck heading id in the empty state so the landmark stays labelled', () => {
    const markup = renderToStaticMarkup(<OnDeckPanel selectedProduct={null} eventId="demo-room" />);
    expect(markup).toContain('<section class="stage-panel" aria-labelledby="on-deck-title">');
    expect(markup).toContain('<h3 id="on-deck-title">Choose a product</h3>');
    expect(markup).toContain('class="empty-state"');
    expect(markup).not.toContain('on-deck-product');
  });
});
