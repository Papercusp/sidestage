# theme-audit — live theme QA for the SideStage web app

Machine checks for the things a unit test cannot see, because they only exist once
the browser has computed styles and painted: **contrast**, **palette drift**, and
**native-widget theming**.

Built for P-004 of `sidestage-red-yellow-retheme-2026-08-13` (the R3 "Ticket" retheme)
and kept because the whole class recurs on every theme change.

## Why it exists — the bug that motivated it

`accent-color` was unset, so ~51 checkboxes in the seller catalog grid rendered in
Chromium's **default blue** on a fire-red/taxi-yellow theme. Nothing caught it:

- unit tests assert structure, not paint;
- a **contrast** audit cannot see it either — a native widget's fill is not a computed
  text colour, so it contributes nothing to any fg/bg ratio.

`probe-accent.mjs` finds that class deterministically. Run it after any theme work.

## Run it

Needs the dev app running (`npm run dev` → web :5173, api :3100). `playwright` is a
declared devDependency of `apps/web` (EI-21343954787970444 — it used to resolve only by
accident via a sibling repo's install), so a normal `npm run install:safe` provides it.
If the Chromium build is missing from `~/.cache/ms-playwright`, run
`npm run qa:browsers --workspace @papercusp/sidestage-web` (wraps
`playwright install chromium`) once. `npm run qa:sweep` / `npm run qa:responsive` run
the two main entry points without the bare `node` invocation; the guard test
`src/tools-declared-deps.test.ts` fails if any `tools/**` script ever imports an
undeclared package again.

```bash
node tools/theme-audit/qa-sweep.mjs        # all four tabs: contrast + drift + D-003 + screenshots
node tools/theme-audit/probe-accent.mjs    # native controls: expect unthemed:0 on every tab
node tools/theme-audit/probe-semantics.mjs # D-003: drives the rehearsal runner, reads status chips
node tools/theme-audit/deep-sweep.mjs      # states behind an interaction
node tools/theme-audit/probe-inventory.mjs # proves surfaces RENDERED (see below)
```

Screenshots + `report.json` land in `QA_OUT` (default a scratch dir); override with
`QA_OUT=/somewhere`.

## Two properties worth preserving if you edit these

**1. Every probe carries a falsifiable control.** Each asserts that `--brand-red`
resolves to `rgb(214,43,31)` *and* that a deliberately-undefined token resolves to `""`.
A blank, half-loaded, or wrong page therefore **fails** the check instead of passing it
vacuously. Do not drop the control — a check that cannot fail proves nothing.

**2. Render is proven before "0 failures" is believed.** An *empty* panel scores zero
contrast failures exactly like a *clean* one. `probe-inventory.mjs` asserts the panels
actually have content (auction root with copy, rail items, guide rows) so a green
reading means "clean", never "absent".

Related: these run in their **own** Chromium on purpose. The shared `verdict` daemon is
a singleton that another agent's navigation silently retargets mid-run
(EI-20403007799747278), which manufactures both false failures and false passes.

## Reading the output

- `contrast` — WCAG AA (4.5:1 body, 3.0:1 large), backgrounds alpha-composited up the
  ancestor chain. An element over a **gradient** is skipped, not failed: the ground is
  unresolvable, and guessing there would produce false reports.
- `drift` — computed colours absent from the D-004 token set in `audit-lib.mjs`.
  **Expect false positives** and read them before acting: values derived via
  `color-mix()` or an alpha token (e.g. `--scrim` → `#5C3E22` at .38) are legitimate.
  Add genuinely-new tokens to `PALETTE` rather than inlining a hex at a call site (D-002).
- `d003` — a destructive control wearing the **CTA red fill** (`#D62B1F`). Per D-003,
  error is a darker crimson `#A61B10` in an outlined treatment, never the CTA fill.
