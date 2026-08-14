# SideStage page redesign — 2026-08-14

This review covers the six top-level pages in the current SideStage web app: Buyer, Orders, Seller, Build History, Config, and Test.

## Shared direction

- Keep the shipped R3 “Ticket” palette: cream canvas, white paper surfaces, ink text, red primary action, yellow attention, and green success.
- Split the information architecture into buyer work (`Watch`, `Orders`) and operator work (`Studio`, `Releases`, `Settings`, `Rehearse`) while retaining one SideStage identity.
- Give every page one obvious next action and use status text plus color; never rely on color alone.
- Reuse the active registry components `action.primary`, `action.secondary`, `control.select`, `control.checkbox`, and `feedback.banner`.
- At widths below 760px, show one active work panel at a time. Avoid compressed desktop grids and horizontally clipped controls.

## Reports and mockups

| Page | Report | Mockup |
|---|---|---|
| Buyer | [reports/buyer.md](reports/buyer.md) | [mockups/buyer.html](mockups/buyer.html) |
| Orders | [reports/orders.md](reports/orders.md) | [mockups/orders.html](mockups/orders.html) |
| Seller | [reports/seller.md](reports/seller.md) | [mockups/seller.html](mockups/seller.html) |
| Build History | [reports/build-history.md](reports/build-history.md) | [mockups/build-history.html](mockups/build-history.html) |
| Config | [reports/config.md](reports/config.md) | [mockups/config.html](mockups/config.html) |
| Test | [reports/test.md](reports/test.md) | [mockups/test.html](mockups/test.html) |

The mockups are standalone, responsive HTML concepts. They demonstrate hierarchy and interaction direction; they do not change production code.
