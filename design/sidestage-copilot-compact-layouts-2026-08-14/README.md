# SideStage Studio Copilot compact-layout concepts

This design checkpoint compares three ways to make the existing Studio → Copilot
pane substantially denser without changing the product implementation.

## What is preserved

- The current grounded-research composer and `Prepare` action.
- Buyer identity, question, proposal status, editable seller reply, cited sources,
  guarded action, and seller approval/skip controls.
- Explicit evidence and guardrail language; compactness must not hide why a reply
  or action is safe.
- Responsive behavior: wide layouts collapse into one readable column instead of
  becoming horizontally clipped miniatures.

## The three directions

1. **Condensed stack** — the current information architecture with a shallower
   header, tighter spacing, and evidence/action details arranged on one line.
   This is the lowest-risk implementation direction.
2. **Queue + inspector** — proposal scanning in a narrow rail and editing in a
   dedicated detail surface. This uses horizontal space to remove vertical churn.
3. **Triage accordion** — compact queue rows with one expanded review at a time.
   This is the densest option when the seller regularly handles several proposals.

## Papercusp design workflow

The live `react-tailwind` registry was queried before composition. The concepts
reuse `action.primary`, `action.secondary`, and `feedback.banner` where those
primitives fit. The registry has no Copilot queue, editor, evidence-chip, or
guarded-action primitive, so those remain local layout concepts built from the
existing SideStage vocabulary rather than a new shared component system.

- UI IR: [`specs/copilot-compact.ui-ir.json`](specs/copilot-compact.ui-ir.json)
- Interactive comparison: [`mockups/index.html`](mockups/index.html)

The mockup is standalone and responsive. It does not import, alter, or replace
`apps/web/src/CopilotPanel.tsx` or any product stylesheet.
