# v2 acceptance — local evidence

Branch `v2/publishing-engine`. Run 2026-11-19 on Windows 11, Node v26.13.1, pnpm 11.25.0,
Playwright-managed Chromium. **Local runs only.** No CI ran; no deployment was made; nothing
here is live enterprise acceptance. Logs: [`acceptance/`](acceptance/).

## Golden Reference (pilot, private preview)

| Command | Result |
| --- | --- |
| `test:site-builder` | 45 / 45 pass (37 existing + 8 new layout-planner tests) |
| `test:runtime` | 25 / 25 pass |
| `test:knowledge` | 3 / 3 pass |
| `check` | 0 errors, 0 warnings |
| `check:contrast`, `check:editorial` | pass |
| `build`, `verify:output` | pass (13 HTML files) |
| `check:release` | pass in **private** mode; source SHA `84120be0…` |
| `test:browser` | 42 passed, 6 skipped (edition-only tests) |
| `check-page-turn.mjs` | 5 / 5 turns with a view transition in the right direction; arrows inert in form fields |
| `lint` | 4 errors — **the same 4 as the untouched baseline** (`release-gate.mjs`, `review.spec.ts`); none added |

## Synthetic editions (private, noindex — fixtures, not real companies)

| Fixture | Family (planner) | check / build / verify | Browser |
| --- | --- | --- | --- |
| `enterprise.synthetic.json` — 2 textile products, abstract art | `editorial-journal` | pass | 51 passed |
| `enterprise.edge-cases.json` — industrial, 40-char name, markup in data | `technical-dossier` | pass | 48 passed |
| `enterprise.empty.json` — no products | `sparse-brief` | pass | 42 passed |
| `enterprise.catalog.json` (new) — 7 products | `catalog-index` | pass | 69 passed |

Each edition's `layout-plan.json` is in its acceptance folder. `validate-content` re-planned each
pack and found no drift.

## Not tested / not claimed

- `accept:site-builder` and `accept:site-worker`: they require exactly Node 24 and were **not run**.
- Public release: the approved review (`2026-11-19-review.json`) covers the *old* source. This
  branch runs `publication.mode = "private"`; going public needs a new human/visual review.
- Live AI sourcing, OpenMausBot ingestion, licensed photography, paid image generation, hosted
  D1 enquiries, Lighthouse and linkinator: not run.
- Page turn checked in Chromium only. Safari/Firefox fall back to plain navigation (not tested).
- Screenshots were converted to WebP; full-page captures are kept for home pages only (size).
- A passing suite is not an aesthetic pass: see the art-director notes in REFERENCE-EDITION.md.
