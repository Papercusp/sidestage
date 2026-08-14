# Config page design report

## Outcome

Make configuration consequence-aware: settings should explain whether the event is safe to run, what remains blocking, and what each guardrail changes in practice.

## Current-state evidence

- The desktop form is clean but sparse; it shows event settings and three checkboxes without indicating that Test currently reports a blocking missing price floor.
- `Save event defaults` sits apart from the form and offers no visible dirty, saving, saved, or failed state.
- On mobile the guardrail card continues below the first viewport, while the save action is not visible.

## Recommended design

1. Add an event selector and a compact readiness banner at the top. A blocking issue links directly to its field.
2. Group settings into `Event identity`, `Copilot behavior`, `Commerce guardrails`, and `Automation`. Show a completion marker per section.
3. Convert each guardrail to a title, plain-language consequence, current value, and optional advanced detail.
4. Add the missing price-floor and discount-cap controls to the same page that owns guardrail intent.
5. Use a sticky save bar with unsaved count, validation summary, save state, and `Run preflight` secondary action.

## Interaction and accessibility

- Reuse registry select, checkbox, primary action, secondary action, and warning/success banners.
- Invalid fields link from the summary and receive focus only after explicit submit.
- Switches and checkboxes keep explicit labels; never use a toggle for a destructive or ambiguous policy.
- Mobile section accordions default to the blocking section open and keep the save bar above the browser safe area.

## Success criteria

- A seller can identify and resolve every blocking configuration issue from this page.
- Save state and scope are always visible.
- Test readiness and Config settings cannot contradict each other without an inline warning.

Mockup: [../mockups/config.html](../mockups/config.html)
