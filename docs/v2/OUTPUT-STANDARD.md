# Output standard

An edition passes only when every hard gate below passes. Aesthetic review is separate and is
never replaced by a test result.

## Hard gates (machine-checked)

| Gate | Check | Where |
| --- | --- | --- |
| One H1 matching the page contract | `verify-output`, browser suite | `scripts/verify-output.mjs` |
| Every evidence claim + exact value + source URL visible on its page | `verify-output`, browser suite (`#source-notes`) | |
| Decision summary (`#buyer-summary`) precedes the article body | `verify-output` | |
| Enquiry links carry the page context | `verify-output` | |
| Private/edition builds `noindex, nofollow`; public needs a review matching the exact source fingerprint | `verify-output`, `check:release` | `scripts/release-gate.mjs` |
| Media bytes/hash/labels bound to pages; AI/abstract captions visible | `prepare:media`, `validate-content`, browser suite | |
| Layout plan valid **and identical to a re-plan of the pack** | `validate-content` (`LAYOUT_PLAN_DRIFT`) | `site-builder/layout-planner.mjs` |
| No horizontal overflow at 1440 / 390 / 360; images decode; assistant dialog keyboard-closable | browser suite | `tests/browser/review.spec.ts` |
| Page turn: arrows/links follow folio order, transition direction correct, arrows inert in fields | `scripts/check-page-turn.mjs` | |
| WCAG AA for all token pairs, all palettes, light + dark | `check:contrast`, `check:editorial` | |

## Page contracts

| Page | Must show above the ledger | Must never |
| --- | --- | --- |
| Home | Masthead (H1), source dateline derived from evidence, lead story, contents | Claim a commercial relationship; show abstract art as a cover |
| Product | Headline, standfirst, picture *or* marginal artwork with provenance | Put a value in large type that is not the stored value verbatim |
| Supplier | Stated facts, then "what this profile does not establish" | Imply capacity, certification or partnership |
| Guide | The buying question as the headline | Repeat marketing copy |
| Sources | Every fact: claim, value, status, source, capture date | Drop an expired or conflicting fact silently |
| Enquiry | Context, consent, receipt, "not sent to a supplier" | Store contact details in the browser draft |

## Package (`buyer-site-package`)

The builder pack already holds `manifest.json`, `site.json`, `pages.json`, `evidence.json`,
`sources.json`, `visual-plan.json`, `media-plan.json`, `media-report.json`, `receipt.json` and
`articles/`. v2 adds `layout-plan.json` ([schema](schemas/layout-plan.schema.json)). The pack
folder name carries its content fingerprint; the layout plan carries `plan_sha256` and is
reproducible from the other files.
