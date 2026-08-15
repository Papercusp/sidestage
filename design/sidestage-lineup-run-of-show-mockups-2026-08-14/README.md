# SideStage Lineup + Run of Show study — 2026-08-14

This preview-only study explores three ways to merge SideStage's event Lineup and run-of-show planner into one seller workspace. It changes no production behavior.

## Shared product model

Every direction renders and edits the same in-browser show plan:

- ordered event products with stage state, price, stock, and SKU;
- an optional minutes budget and seller-facing talking notes per product;
- products reserved for the event but not yet in the show plan;
- drag-and-drop ordering on pointer devices plus explicit Move up / Move down controls for keyboard and touch users.

Changing the order, timing, notes, or plan membership in one concept updates the other two. That keeps this study focused on interaction architecture instead of comparing different data.

## Concepts

| Concept | Shape | Best quality | Primary trade-off | Mobile behavior |
|---|---|---|---|---|
| 01 · Inline flow | One sortable Lineup with timing and notes inside each row | Highest context continuity | Densest rows | Fields stack under each product; arrow controls remain visible |
| 02 · Focus inspector | Compact sortable Lineup plus one focused editor | Calmest scan and strongest progressive disclosure | Editing requires selecting a row | Inspector moves directly below the list as a full-width sheet |
| 03 · Manage / Plan | One Lineup surface with explicit commerce and planning modes | Clearest task separation while preserving one destination | Sellers must understand the mode switch | Mode control becomes sticky; plan rows become compact cards |

P-002 deliberately does not select a winner. P-004 owns cross-viewport browser QA, the comparison, and the recommendation.

## Reused SideStage system

- Palette, surfaces, controls, badges, and header chrome reuse `../sidestage-page-redesign-2026-08-14/mockups/shared.css`, which mirrors the shipped Ticket theme tokens.
- Product and stage language comes from `apps/web/src/events/EventLineupGrid.tsx` and `apps/web/src/seller/RunOfShowPanel.tsx`.
- Minutes, notes, order, and advisory-plan semantics come from `apps/web/src/seller/RunOfShowPlannerPanel.tsx` and `apps/web/src/run-of-show.ts`.
- The interaction remains advisory: reordering never stages a product, and the live item stays visibly separate from planning actions.

## Interactions

- Switch concepts with click/tap, Left/Right arrows, Home/End, or the URL hashes `#inline-flow`, `#focus-inspector`, and `#manage-plan`.
- Drag a dotted handle onto another row to reorder on desktop.
- Use the accessible arrow buttons to reorder with keyboard or touch.
- Edit minutes and notes, add or remove reserved products, switch Manage / Plan modes, save the local draft, or reset the shared scenario.
- Status messages use an `aria-live` region; focus-visible styling and reduced-motion behavior are included.

## Files

- `index.html` — comparison shell and semantic landmarks for all three concepts.
- `styles.css` — SideStage-native responsive presentation.
- `app.js` — shared content model, synchronized rendering, drag-and-drop, keyboard tabs, and local preview actions.

Serve this directory through any local static server; no build step or external dependency is required.
