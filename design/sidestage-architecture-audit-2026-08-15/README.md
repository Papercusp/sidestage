# SideStage architecture audit and simplified mockups

This checkpoint independently compares every claim on `apps/web/src/ArchitectureTab.tsx` with the current SideStage source tree.

- [`audit.md`](./audit.md) contains the claim-by-claim verdict and correction copy.
- [`mockups/index.html`](./mockups/index.html) compares three deterministic, implementation-neutral page directions.
- `specs/` contains one UI-IR document per direction.
- `qa/` records validation and rendered browser evidence.

The strongest direction is **01 · Authority map**. It makes ownership and runtime truth legible without presenting configured-but-unused infrastructure as active. The mockups are design artifacts only; no product source was changed.

## Source baseline

- Audit date: 2026-08-15
- Audited page: `apps/web/src/ArchitectureTab.tsx`
- Canonical checkout: `/home/marsh-office/.papercusp/hives/sidestage`
- Reuse decision: no matching Papercusp design-registry component was found during the required registry search, so the mockups reuse SideStage's existing visual vocabulary (navy type, red/cyan/green accents, compact cards, status pills) without creating a product component system.

