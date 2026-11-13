# BuyerSite browser acceptance — 2026-11-13

## Result and scope

**The standalone builder passes synthetic acceptance: 10 unit tests, three
check/build/output runs and 96 browser tests.** There are no skipped, flaky or
unexpected browser results. This supersedes the earlier browser-launch blocker
in `2026-11-13-builder-acceptance.md`.

This is not a live company or production acceptance. The Studio lifecycle,
protected multi-route preview, real enterprise ingestion, publishing approval,
conversion backend and production rollout are still NOT_TESTED / not connected.

## Revisions and environment

- Tested clean local implementation: `8a72c1661356faaf300d241c9c8c12ca22315e1b`.
- Published equivalent code: `ff9d4978fb5c9b5f01d841b4633a1519a4ebfb0b`.
- Both implementation trees: `07a24917d16585848d59bf524bd499139a5e24f8`.
- A final native capture URL-binding check was tested separately at local
  `72d40aa924a659dd456ede9a9a9bb52f6fc0838e`, published as
  `305f63e57ffe7f5cf0673d8abe161bc5dcf5cec9`, identical tree
  `c28b15335c6767e8f92b60d1bd7e9d933d1f8812`.
- Linux x64, Node 24.22.1, pnpm 11.25.0, Astro 7.3.3, Playwright 1.65.0,
  Chromium Headless Shell 153.0.8010.0 from `@sparticuz/chromium@153.0.0`.
  Configured pnpm 10.34.5 remains a separate untested reproduction.

The external QA runtime uses fresh Playwright contexts and removes the
single-process flag, which otherwise terminated the browser when the first
context was closed. It is not a production dependency or the user's browser
profile. The reproducible launcher is `scripts/prepare-headless-runtime.mjs`;
setup and acceptance commands are documented in `site-builder/README.md`.

## Defects found by execution and visual inspection

1. Astro 7 blocked SVG rasterization: fixed with repository-owned PNG artwork.
2. Astro agent-mode preview detached: fixed by foreground `--ignore-lock`.
3. Generated Playwright reports entered Astro's typecheck and exhausted memory
   on a subsequent run: generated directories are now excluded in tsconfig.
4. A long synthetic company name overflowed footer and card headings on mobile.
   Initial automated checks ran before lazy layout exposed it. Wrapping now
   covers those elements, and tests check final page width and full-page PNG
   width after scrolling. Representative desktop and 360px images were visually
   inspected after the fix; the long-name output stays within the viewport.

## Acceptance results

| Synthetic edition | Core routes | HTML files checked | Browser tests passed |
| --- | ---: | ---: | ---: |
| Cotton textiles, two products | 5 | 11 | 36 |
| Industrial, long name and escaped markup | 4 | 10 | 33 |
| Empty product library | 3 | 8 | 27 |
| Total | 12 | 29 | 96 |

All built page routes were read at desktop 1440px, mobile 390px and mobile
360px. Checks cover H1/evidence text, noindex, local fonts/images, disabled AI
Assistant, unsent enquiry download without network submission, navigation,
back/forward and refreshing deep links. Source checks also verify all local
links/assets, canonical tags, JSON-LD and absence of Burel pilot data.

Raw full-suite report:
`.generated/acceptance/2026-11-13T08-48-11-991Z/report.json`.
Machine-readable results and complete artifact inventory digests are recorded in
`2026-11-13-browser-summary.json`.

After the final URL-binding adapter change, all 10 unit tests and Astro
check/build/output verification passed again. The rebuilt empty-catalog output
was checked file-by-file against the browser-tested inventory and is byte
identical. Rendering files were unchanged by that final adapter-only change;
the 96 browser checks were not needlessly rerun.

## Native input adapter and remaining host work

`createSiteFromStudio` accepts the existing server-owned Studio job and its
original frozen source.json bytes. It checks the enterprise, source hash,
company/product revisions, selected product IDs, archived state and recorded
capture permission. It only captures the exact job URL on the native profile's
origin. Internal SKU prices, supply policies, documents and unapproved photos
are excluded from the compiler projection. The source binding is returned for
retention on the same job. A visitor-supplied job is not authenticated by this
function; the native route remains responsible for authentication.

Separately, the existing OpenMausBot Studio baseline at `311881a...` was
materialized from the private repository and its 11 original Studio unit tests
passed, including retry/restart and cross-enterprise preview/file isolation.
These are baseline unit results, not tests of an installed Site integration.
No worker production code was modified or deployed in this run.

Next work is still to add outputKind=site to the existing Studio lifecycle,
call the input adapter from a trusted step, return an independently verified
build to that same job and serve every route through authenticated preview.
The server console was located, but instance login verification did not succeed;
no authenticated enterprise export or server change was performed.
