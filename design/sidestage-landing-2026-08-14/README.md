# SideStage landing page + auction comparison — 2026-08-14

Two standalone HTML deliverables from the landing-page pass (WI-38700) and the
auction-panel graft that followed it. Both were published as Claude artifacts
first and existed **only** as those URLs; this directory is their source of
truth (WI-38738).

| File | What it is | Published as |
|---|---|---|
| [landing.html](landing.html) | SideStage marketing landing page — hero with a live-auction "Board" animation, plus the closing call to action. | ["SideStage Live Selling"](https://claude.ai/code/artifact/5c70e2b3-27a3-4e8c-b4d4-a6fc1deedef2) |
| [auction-board-vs-panel.html](auction-board-vs-panel.html) | Side-by-side of the app's shipping `AuctionPanel` against the landing page's Board concept, both driven by one simulation, with a capability matrix and a graft recommendation. | ["The Board vs The Panel"](https://claude.ai/code/artifact/3cb1079b-eb11-4e2b-8334-9f2b4d2af1c0) |

Open either directly in a browser (`file://`) — they are fully self-contained:
no external stylesheets, scripts, fonts or images, and no network requests at
all. Both use the shipped **R3 "Ticket"** palette from
`apps/web/src/styles.css` (plan `sidestage-red-yellow-retheme-2026-08-13`),
so they stay honest about the product's real colour.

## Scope — what these are and are not

`landing.html` is **marketing**, not product: its auction Board is a scripted
animation with no bidding in it. The comparison page says so explicitly, and
that distinction is the whole point of the comparison — the recommendation is
to graft the Board's *presentation* onto the Panel, not to replace the Panel.

## Provenance, and how to republish

Each file is the authored artifact source with the artifact host's own wrapper
(doctype, charset/viewport, minimal reset) reproduced around it, so the
standalone file renders as the published page does. Republishing a change:
edit the file here, then publish **this path** to the **existing URL above** —
passing that URL explicitly, or you fork a second artifact instead of updating
the original.

## Verified

Rendered headless from `file://` on 2026-08-14 and inspected as pixels, not
just as bytes:

- `landing.html` — 2 sections (hero + close), body background `rgb(255,248,239)`
  (the R3 cream), auction Board animating: countdown ring draining, price
  tweening on each bid, bid feed stacking.
- `auction-board-vs-panel.html` — both specimens rendered and driven by the
  same simulation (Panel `$124.00` / Board `$124`, same leader), 10 matrix
  rows, 4 recommendation steps.
- Neither file issues a network request; both contain zero external references.

## History worth knowing

The landing page was **trimmed from 6 sections to 2** and re-themed from the
old dark palette to R3 under WI-38700. An earlier 6-section dark version exists
in session captures and is **superseded** — if you find one, it is not this.
