# SideStage Studio live engagement overlay — shipped 2026-08-14

SideStage now ships one video-owned engagement overlay for buyer and seller. It combines live captions, expandable transcript history, product context, and Event Chat instead of stacking independent transcript and chat panels. This folder retains the earlier seller-chat concepts as future product research; their reply and queue interactions remain preview-only.

## Shipped outcome

- `apps/web/src/VideoEngagementOverlay.tsx` composes Event Chat with the role-neutral `TranscriptOverlayView`. Chat remains mounted while collapsed so its subscription and message state survive view changes, and opening it scrolls the explicit message target to the latest row.
- The seller Live console supplies the existing live transcript controller through `liveTranscriptPresentation`. Capture, provider state, interim captions, final history, product-mention confirmation, and active-product context remain seller-owned.
- The buyer live stage reads persisted moments through the event-scoped `event.chat.transcript` sync query and adapts them with `remoteTranscriptPresentation`. Empty and unavailable feeds have explicit caption states.
- The seller’s default Active Event dock no longer includes standalone Event Chat or transcript panels. The mobile Studio no longer exposes a separate Chat tab, and saved active-event layouts migrate retired chat/transcript/on-deck panels out before Dockview restores them.
- The shared toolbar exposes connected `aria-controls` / `aria-expanded` chat and transcript-history toggles. Caption changes use a polite atomic live region; transcript history is a labelled, keyboard-focusable region; transcript failures use an alert.

## Product boundary

The shipped overlay consolidates visibility and navigation; it does not add seller replies, queue resolution, or Copilot send behavior. Those interactions still require a grounded review/send seam. The three concepts below remain a comparison study for that later workflow.

## Retained concepts

The recommended future direction remains **Answer Queue**, borrowing **Live Pulse**’s compact message metadata for narrow surfaces.

| Concept | Primary model | Best quality | Main trade-off | Status |
|---|---|---|---|---|
| 01 · Answer Queue | Unanswered buyer questions become actionable work | Fast, safe resolution | Social room chatter becomes secondary | Preview only |
| 02 · Conversation + Focus | Chronological conversation beside a persistent focus lane | Best room awareness | Requires a wider workspace | Preview only |
| 03 · Live Pulse | Dense signals inside the compact overlay | Smallest workflow change | Less space for reply drafting | Preview only |

## Grounding and reuse

- The shipped baseline is `VideoEngagementOverlay`, `LiveTranscriptOverlay`, `EventChat`, `BuyerTab`, `seller/StageStatusPanel`, and the existing seller dock migration seam.
- The overlay extends SideStage’s existing video-overlay, cream/paper/ink, action, badge, focus, and responsive conventions instead of introducing a parallel component system.
- Registry discovery found the shared `action.primary`, `action.secondary`, and `feedback.banner` primitives; the retained concepts reuse those roles.
- The App-level selected product remains the single source of truth. Transcript presentation can show or suggest product context, but it does not introduce another general-purpose product picker.

## Verification map

- `apps/web/src/VideoEngagementOverlay.test.tsx` — shared composition, connected chat toggle, collapsed-but-mounted chat, remote transcript states, and latest-message scrolling.
- `apps/web/src/LiveTranscriptOverlay.test.tsx` — caption/history presentation and seller-controller adaptation.
- Buyer, seller Studio, dock-layout, and dock-store tests — role mounting, responsive navigation, default panel inventory, and saved-layout migration.
- `specs/event-chat-comparison.ui-ir.json` — shipped-baseline documentation plus retained future concepts, validated and linted through the design-phase tools.

## Preview files

- `index.html` — the retained comparison page for the three future Event Chat workflows.
- `styles.css` — responsive preview styling layered on SideStage’s existing mockup tokens.
- `app.js` — keyboard-operable concept switching and explicitly preview-only queue/reply interactions.
- `specs/event-chat-comparison.ui-ir.json` — UI IR for the shipped overlay baseline and future concept comparison.

Serve this folder through a local static server to inspect the retained study. Stable hashes open each direction directly: `#answer-queue`, `#split-room`, and `#live-pulse`.
