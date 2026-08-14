# SideStage Studio Event Chat study — 2026-08-14

This is a preview-only comparison of three ways to improve the seller-facing Event Chat panel in SideStage Studio. It changes no application behavior.

## Recommendation

Use **Answer Queue** as the foundation and borrow **Live Pulse**’s compact message metadata for narrow dock sizes.

The current panel can identify important messages, but it stops before the seller’s real job is complete. The recommended direction closes the loop:

1. Notice the right buyer question.
2. See the relevant live product or checkout context.
3. Open a grounded reply draft.
4. Send or explicitly mark the question handled.
5. Advance to the next waiting buyer.

## Concepts

| Concept | Primary model | Best quality | Main trade-off | Build size |
|---|---|---|---|---|
| 01 · Answer Queue | Unanswered buyer questions become actionable work | Fast, safe resolution | Social room chatter becomes secondary | Medium |
| 02 · Conversation + Focus | Chronological conversation beside a persistent focus lane | Best room awareness | Requires a wider workspace | Large |
| 03 · Live Pulse | Dense signals inside the existing narrow dock | Smallest migration | Less space for reply drafting | Small |

## Grounding and reuse

- The baseline is the shipped seller surface in `apps/web/src/EventChat.tsx`, `apps/web/src/styles.css`, and `apps/web/src/seller-dock-layout.ts`.
- Color, surface, typography, button, badge, focus, and responsive conventions reuse `design/sidestage-page-redesign-2026-08-14/mockups/shared.css`.
- Registry discovery found the shared `action.primary`, `action.secondary`, and `feedback.banner` primitives; all three concepts reuse those roles rather than creating a parallel action system.
- The generic workspace token registry is intentionally not used for the visual palette because it describes the dark Papercusp operator shell, not SideStage’s shipped cream/paper/ink visual system.
- Seller replies are a proposed capability, not a claim about current behavior. The current seller management surface is read-only; a production implementation should route reply drafting through the existing grounded Copilot review/send seam.

## Files

- `index.html` — one comparison page containing all three interactive mockups.
- `styles.css` — responsive styling layered on SideStage’s existing mockup tokens.
- `app.js` — keyboard-operable concept switching, reply drafting, queue resolution, filters, and preview feedback.
- `specs/event-chat-comparison.ui-ir.json` — UI IR used for schema validation and anti-pattern linting.

Serve this folder through a local static server. Stable hashes open each direction directly: `#answer-queue`, `#split-room`, and `#live-pulse`.
