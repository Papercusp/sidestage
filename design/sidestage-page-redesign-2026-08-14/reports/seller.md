# Seller page design report

## Outcome

Turn the Seller page into an opinionated live control room. The seller should see the stage, the next item, room demand, and the safest next action without managing a windowing system during a broadcast.

## Current-state evidence

- Desktop uses a dock layout with six panels and internal tab chrome. The content hierarchy is determined by window geometry rather than broadcast urgency.
- At 390×844 the desktop dock remains two columns. Headings wrap to one or two words per line, panels are clipped, and controls become impractical.
- Event setup contains a 50-row editable catalog inside the same surface as stage control, transcript, chat, copilot, and on-deck content; the live and preparation modes compete.

## Recommended design

1. Split the experience into explicit modes: `Prepare` and `Live`. Preparation owns event setup and catalog; Live owns stage, lineup, chat, and copilot.
2. Use a three-zone desktop live layout: stage preview and controls (main), run-of-show/on-deck (right), and a bottom activity strip for chat, transcript, and copilot.
3. Provide a persistent broadcast bar with connection, viewers, elapsed time, current item, and one safe stage action.
4. Replace free-form dock management with saved role-based views. Keep `Customize layout` as an advanced secondary path.
5. On mobile, show one active panel with a bottom mode switch (`Stage`, `Lineup`, `Chat`, `Copilot`) and a sticky `Next item`/`End item` action.

## Interaction and accessibility

- Dangerous actions require a labeled confirmation sheet that names the item and consequence; routine stage transitions remain one tap.
- Keyboard shortcuts must be discoverable and disabled while text inputs have focus.
- New chat priorities and copilot proposals use live-region summaries, not focus stealing.
- Preserve resizing only on desktop; mobile panels must never be horizontally compressed.

## Success criteria

- A seller can identify the current and next item, room health, and primary action in under three seconds.
- No live-control text or input is clipped at 390px.
- Catalog preparation is not present in the live operator’s critical path.

Mockup: [../mockups/seller.html](../mockups/seller.html)
