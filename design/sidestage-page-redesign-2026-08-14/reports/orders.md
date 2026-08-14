# Orders page design report

## Outcome

Make Orders a reassuring purchase timeline, not merely a ledger or empty-state endpoint. Buyers should immediately understand what they bought, what happens next, and how to revisit the live moment.

## Current-state evidence

- The empty state occupies most of the 1440×1000 canvas but offers no direct route back to a live event.
- The identity and refresh controls are visually detached from the page title. On mobile they become a second large card before any order content.
- The page copy promises checkout, auction, private-offer, and video history, but the empty state does not preview that value.

## Recommended design

1. Replace the oversized hero with a compact header containing order count, total spend, open fulfillment count, and a `Continue shopping` primary action.
2. Add filters for `All`, `Needs action`, `In progress`, and `Completed`, plus a compact order search.
3. Render orders as grouped cards: product thumbnail, source event, purchase type, amount, timestamp, fulfillment status, and one dominant next action.
4. Put the captured live moment behind a clearly labeled `Watch purchase moment` action rather than embedding media in every row.
5. For zero orders, show a small sample card silhouette and two routes: `Browse live events` and `How buying works`.

## Interaction and accessibility

- Use semantic lists and headings; status is text plus an icon and tone.
- Collapsed cards expose order id, item, total, and status; expanded cards reveal timeline, delivery address summary, payment, and support.
- On mobile, keep filters horizontally scrollable with a visible selected state and place the primary action below the order summary, not in a distant sidebar.
- Refresh should preserve filter position and announce the result without resetting focus.

## Success criteria

- Every order communicates status and next action without opening it.
- Empty-state users have a direct path back to a live event.
- Mobile users can scan five orders without horizontal scrolling or repeated full-detail evidence.

Mockup: [../mockups/orders.html](../mockups/orders.html)
