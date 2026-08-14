# Buyer page design report

## Outcome

Turn the Buyer page from a stream shell with commerce below the fold into a live-shopping room where video, the current offer, bidding, and chat are visible as one coherent decision surface.

## Current-state evidence

- At 1440×1000 the video dominates the left column, chat occupies a narrow right rail, and the product list begins below the viewport. The primary commercial action is therefore separated from the moment that creates intent.
- At 390×844 the identity switcher, guide, share action, video, metrics, auction, products, and chat form one long stack. The first product is not visible in the initial viewport.
- “Connect to stream” is visually stronger than shopping while the room is not live, and three equal-weight metric cards consume vertical space without helping the buyer decide.

## Recommended design

1. Use a compact room header: live status, event title, viewer count, guide, and share action. Move the demo identity control into a small account popover.
2. Make the stage a two-column composition on desktop: 16:9 video plus a persistent “Now selling” card with image, price, remaining quantity, bid/hold action, and fulfillment note.
3. Reduce the three stats to a single quiet metadata row. Promote the auction state only when an auction is active.
4. Show the next three products immediately below the stage as visual cards; keep the complete catalog behind “View all items.”
5. Treat chat as a companion panel that can collapse. On mobile, expose `Shop` and `Chat` as modes below the video rather than appending both full surfaces.

## Interaction and accessibility

- Keep the current registry primary action for `Hold item`/`Place bid` and the secondary action for share and guide.
- Announce bid and availability changes through a polite live region; never move focus on an automatic update.
- Preserve descriptive button labels with product context. Maintain 44px targets and a sticky mobile action bar that does not cover content.
- If the stream is offline, replace the black void with an event poster, start time, and one useful action: `Notify me when live`.

## Success criteria

- The current product, price, and buying action are visible in the first desktop and mobile viewport.
- A buyer can reach the full catalog or chat in one action without losing the stream.
- Offline, auction, sold, and low-stock states are understandable without color.

Mockup: [../mockups/buyer.html](../mockups/buyer.html)
