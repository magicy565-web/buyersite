# Phase 0 baseline — what the reviewed source looked like

Source: extract of `magicy565-web/buyersite` at reference `73643f573ef6`, committed here as
`0cc0ef2` (no `.git` was shipped with the extract, so the upstream HEAD and PR state could not
be read from this checkout). Screenshots: [`screens/baseline/`](screens/baseline/) at 1440, 768,
390 and 360 px, taken before any design change.

## Environment defects found and fixed first (not design)

| Defect | Root cause | Effect | Fix |
| --- | --- | --- | --- |
| `pnpm build` fails on Windows with `PUBLIC_RELEASE_REVIEW_STALE` | `releaseFingerprint()` joined paths with `\`, so the `publication.json` exclusion never matched and every row name differed | Reviewed source looked tampered with | POSIX-normalised paths (`scripts/release-gate.mjs`). The untouched baseline then reproduces the reviewed SHA `76fdf7b3…` exactly |
| Every static asset 404s in local preview on Windows | `startsWith(staticRoot + '/')` in `scripts/dev-server.mjs`; no `.avif` MIME | Images fail; browser suite fails | `path.sep`; AVIF/ICO MIME types |
| Enterprise editions fail to build on Windows | Astro `file()`/`glob()` read `Y:\…` as a URL with scheme `y:` | No edition can build | Project-relative POSIX loader paths (`src/content.config.ts`) |
| Browser suite fails after ~30 pages | Aggregate analytics limiter (60/min/client) answers 429 to one loopback client | False page failure | The spec tolerates a 429 from `/api/events` only; every other 4xx/5xx still fails |
| `accept:site-builder` refuses to run | Hard requirement of Node 24; this machine has Node 26.13.1 | Builder acceptance harness unusable | Not bypassed. Editions were driven through the builder's own commands instead (see ACCEPTANCE) |

## Design defects (baseline screenshots)

Determinable = measurable/reproducible; subjective = art-direction judgement.

| # | Where | Observation | Type | Root cause |
| --- | --- | --- | --- | --- |
| D1 | Home cover, all widths | Material photograph almost invisible; at 390 px the first screen is a flat dark block | Determinable | `.plate::after` scrim 92 % plate across 54 % (desktop) and 80 % of height (narrow), plus an extra top band in `editorial.css` |
| D2 | Header, ≤ 640 px | Two wrapped rows of nav + action labels, ~190 px before content; "System" theme label reads as a nav item | Determinable | `Base.astro` header + `theme.css` wrap rules |
| D3 | Product page, all widths | Image arrives after a dense two-column spec block; at 390 px no picture in the first screen | Determinable | `[slug].astro` renders `SpecSummary` before the figure |
| D4 | Product page, 1440 | Single 42 rem column centred in a 1440 viewport: reads as a document, not a magazine | Subjective | `max-w-content` shell for all non-rail pages |
| D5 | Product page | Same three facts printed three times (summary, body, source notes) with equal visual weight | Subjective | No hierarchy between the decision summary and the evidence appendix |
| D6 | Home 1440 | Large empty areas: left column under "Material review", lone "Ask a sourcing question" button floating before the footer | Determinable | `Assistant.astro` prints an in-flow opener on every page; grid columns of unequal content |
| D7 | Theme | Visual directions only change colours/fonts; `.grid article` selectors in `theme.css` no longer match any component | Determinable | Selectors written for the pre-editorial home grid |
| D8 | Generated editions | Every edition gets the same section order and a large abstract artwork on the cover and every page | Subjective | `visual-director.mjs` picks a skin by keyword; no layout decision exists |
| D9 | Enquiry | Visit-context block ("First page in this session /") always open; context select pre-filled from the visit | Subjective | `EnquiryForm.tsx` |
| D10 | Captions | "AI-generated concept illustration … AI-generated editorial concept" — caption and credit both printed | Subjective (kept) | Caption and credit are separate provenance fields; both remain required |
