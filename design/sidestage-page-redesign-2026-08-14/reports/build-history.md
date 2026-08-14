# Build History page design report

## Outcome

Make Build History a trustworthy release digest with progressive disclosure. Readers should scan what changed and why it matters before choosing to inspect raw completion evidence.

## Current-state evidence

- The first plan expands every completed work item and every evidence field. The page exposes more than 200 interactive references on mobile and becomes an extremely long archive.
- Plan title, slug, item count, status, dates, work-item titles, and evidence all compete at nearly the same visual weight.
- Refresh is the only control; there is no search, status filter, date range, collapsed summary, or direct link to a specific plan.

## Recommended design

1. Add a release summary row: latest verified change, completed this week, active plans, and last sync.
2. Provide search plus filters for status, date, and work type. Default to recently updated plans.
3. Render one collapsed plan card per plan with status, concise outcome, progress, owner/source, and last update.
4. Expand work items on demand. Summarize evidence into `What changed`, `Verification`, and `Files`; keep raw fields behind `View full evidence`.
5. Support stable deep links to plans and work items, plus copy-link actions.

## Interaction and accessibility

- Use native disclosure semantics with visible focus and retained open state.
- Search results state the count; filtering never collapses an item the user is actively reading without notice.
- Dates use human-readable text with precise timestamps available to assistive technology.
- Mobile cards keep the summary first and evidence collapsed; no raw command line should force horizontal scrolling.

## Success criteria

- The first viewport explains the latest release state without opening a plan.
- A reader can locate a named plan or work item in one search.
- Raw evidence remains available but is not rendered by default.

Mockup: [../mockups/build-history.html](../mockups/build-history.html)
