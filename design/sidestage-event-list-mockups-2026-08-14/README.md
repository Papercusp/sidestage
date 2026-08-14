# SideStage Studio event-list navigation study — 2026-08-14

This is a preview-only comparison of three ways to add a seller-owned event list to SideStage Studio. It changes no application behavior.

## Recommendation

Use four peer Studio tabs: **Inventory · Create Event · Events · Active Event**.

That model gives each lifecycle job a stable, plainly named destination:

- Inventory answers “what can I sell?”
- Create Event answers “how do I start?”
- Events answers “where is the draft, scheduled, live, or past event I own?”
- Active Event answers “how do I run the room now?”

The additional tab is a visible cost, but it avoids hiding creation under a generic hub or nesting the event list inside an already-dense manager.

## Concepts

| Concept | Studio navigation | Best quality | Main trade-off | Migration |
|---|---|---|---|---|
| 01 · Four tabs | Inventory · Create Event · Events · Active Event | Highest findability and clearest lifecycle | One more top-level tab | Moderate |
| 02 · Events hub | Inventory · Events · Active Event | Compact, calm Studio chrome | Creation becomes an in-page action | Moderate |
| 03 · Event Manager | Inventory · Event Manager · Active Event, with My events / Create event inside | Smallest product and routing change | Nested navigation and a denser manager | Low |

All three concepts deliberately share the same seller-owned event data shape and row actions. Only the information architecture changes, so the eventual implementation can reuse one event-list surface.

## Reused SideStage system

- Palette and surface tokens come directly from **../sidestage-page-redesign-2026-08-14/mockups/shared.css**.
- Primary and secondary actions reuse the registry-discovered **action.primary** and **action.secondary** patterns.
- The baseline navigation is the shipped **Inventory · Event Manager · Active Event** order in **apps/web/src/SellerTab.tsx** and **apps/web/src/studio.css**.
- The mockups keep status text alongside color, keyboard-operable concept tabs, focus-visible controls, responsive card conversion, search empty states, and an accessible live preview message.

## Files

- **index.html** — one comparison page containing all three interactive mockups.
- **styles.css** — responsive concept styling layered on the existing SideStage mockup tokens.
- **app.js** — preview-only concept switching, event filtering, local manager switching, and status feedback.
- **specs/event-list-navigation.ui-ir.json** — UI IR used for schema validation and anti-pattern linting.

Open **index.html** through the SideStage development server or a local static server. The concept switcher preserves a stable hash for each direction: **#four-tabs**, **#events-hub**, and **#event-manager**.
