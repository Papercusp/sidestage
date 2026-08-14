# Test page design report

## Outcome

Turn Test into a launch decision dashboard. It should answer “Can I go live?”, identify the one most valuable fix, and keep advanced rehearsals available without presenting every check at equal weight.

## Current-state evidence

- Desktop places a 2-of-4 preflight card in the left half while most of the first viewport is empty; the blocking setup diagnosis begins below the fold.
- The page later presents full rehearsal, four seam rehearsals, load rehearsal, and reply judge as similarly weighted cards.
- On mobile the preflight card is readable, but the user must scroll through a long sequence before reaching lower tests or understanding the recommended order.

## Recommended design

1. Lead with a launch verdict: readiness score, explicit `Not ready`, number of blockers, last run, and one `Run full rehearsal` action.
2. Place the highest-priority blocker immediately beside/below the verdict with `Fix in Settings` and `Re-check` actions.
3. Group rehearsals into `Required before live` and `Advanced confidence`. Each card shows duration, last result, freshness, and affected capability.
4. Add a run timeline that streams progress and preserves the last report; downloading is secondary to understanding the result.
5. Allow `Run failed only` after an initial pass and make the readiness report shareable by stable URL.

## Interaction and accessibility

- Reuse feedback banners for blocking, running, passed, and stale states; status always includes text.
- Progress uses a labeled determinate indicator where possible, with an activity log for screen readers.
- Disabled tests explain their dependency and link to the corrective page.
- Mobile presents verdict, top blocker, and required rehearsals first; advanced tests collapse under one disclosure.

## Success criteria

- The first viewport states go/no-go and the next corrective action.
- Sellers can rerun only failed checks and see when evidence became stale.
- The final report names every executed check, result, duration, and configuration snapshot.

Mockup: [../mockups/test.html](../mockups/test.html)
