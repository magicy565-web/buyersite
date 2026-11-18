# Buyersite decision-flow delivery and acceptance

**Status:** three-stage implementation and local acceptance complete; public-mode build/output/release gates passed. **Hosted deployment, browser receipt recovery and native D1 context read-back passed; their evidence and limits are recorded below.** The reviewed edition is Material Notes, the source-based Burel Factory pilot. Synthetic checks are not customer-demand evidence.

[Source-bound interactive AI review](2026-11-19-review.json): `76fdf7b32ede89a993d33e28c57b2e3c759d6d8fbf8289646035ac2a51c97272`. Raw execution timestamps are retained in the evidence; the filename is the delivery label.

## Architecture and delivered stages

The existing **Astro 7.3.3 + Halftone + Tailwind 4** magazine uses focused **React 19 / assistant-ui** islands. A same-origin Cloudflare Worker wraps static assets, Pagefind and the public knowledge export; deployment storage is D1, while local development uses real SQLite. No separate dashboard, agent platform, fulfilment service or supplier messaging system was introduced.

| Stage | Delivered scope |
| --- | --- |
| Editorial production | Source/evidence contracts, reusable editorial blocks, three visual directions, licensed-image rights checks, authorized concept generation and image/page AI review binding. |
| Buyer conversion | Shared article briefs, scoped cited-fact search, explicit unknowns, selectable questions, editable requirements, consented enquiry, server-resolved provenance, durable receipts and owner review. |
| Publication and feedback | `/sources/`, revisioned `/buyer-data.json`, source-backed structured data, Pagefind, canonical/robots/sitemap policy, Worker packaging and owner aggregate reporting by article, landing and bounded campaign. |

The two image paths are explicit: use commercially authorized images only with applicable tenant/page rights, transformation permission, current grant and exact derivation; otherwise generate a labelled original concept when authorized, then require AI review. Missing/stale/fixture-only approval cannot pass. The pilot has **three actual generated concepts** with retained provenance and observed interactive AI review. No real commercial licence was supplied; licensed-path tests use synthetic grants. Paid image-generation/vision adapters were tested with fixtures, **not real paid provider calls**. Interactive review is not a fabricated API verdict or human sign-off. [Media contract](../MEDIA-AND-VISUAL-REVIEW.md)

## Verification obtained

| Check | Result and evidence |
| --- | --- |
| Builder/media tests | **37 passed**, zero failed/skipped. [Log](2026-11-19-decision-flow/media-builder-tests.log) |
| Runtime/public-knowledge tests | **28 passed**, zero failed/skipped; real SQLite, mocked model upstream. [Log](2026-11-19-decision-flow/runtime-and-knowledge-tests.log) |
| Total | **65 distinct tests**; repeated enterprise runs are not counted again. Node 24.22.3, pnpm 11.25.0. |
| Type check | **0 errors, 0 warnings, 2 existing hints**. [Log](2026-11-19-decision-flow/check.log) |
| Build/output | **13 HTML pages, 79 finalized static files plus Worker**. [Public build](2026-11-19-decision-flow/public-build.log), [output](2026-11-19-decision-flow/public-output.log) |
| Contrast/release | Token and Atelier/Industrial/Editorial checks passed; exact-source public gate passed. [Contrast](2026-11-19-decision-flow/contrast.log), [release gate](2026-11-19-decision-flow/public-release-gate.log) |

Reproduction targets: `pnpm test:site-builder`, `pnpm test:runtime`, `pnpm test:knowledge`, `pnpm check`, `pnpm check:contrast`, `pnpm build`, `pnpm verify:output`, `pnpm check:release`. No green GitHub-hosted CI is claimed; earlier runner allocation was billing-blocked.

## Browser and local receipt acceptance

**Nine desktop routes** were inspected: `/`, `/materials/silver-wool-fabric/`, `/suppliers/burel-factory/`, `/guides/burel-project-brief/`, `/enquiry/`, `/search/`, `/sources/`, `/colophon/`, `/privacy/`. Narrow review covered home, all three articles, sources, enquiry and the sourcing dialog in a **360 px iframe with 345 px content width after its scrollbar**. This is responsive layout inspection, **not touch/device emulation** or real-buyer research; narrow acceptance is not claimed for search, colophon or privacy. [Screenshots](2026-11-19-decision-flow/screenshots/), [coverage and hashes](2026-11-19-review.json)

Observed interactions retained article/question context, returned the exact cited **140 cm** width, kept unknown terms unconfirmed, returned two Pagefind matches for `wool`, supported context/attribution clearing, and downloaded an explicitly unsent brief. Escape closed the dialog and restored opener focus. No horizontal overflow was observed. Review fixes reduced mobile header/form density and enlarged key targets; no blocking findings remained. [Unsent download](2026-11-19-decision-flow/unsent-brief.txt)

A synthetic browser enquiry reached the **real local Worker and SQLite**: receipt `bf539e43-0559-4e1e-88ea-f647618fae4d`, **one stored row**, article `/materials/silver-wool-fabric`, landing `/`, server-resolved subject/source/evidence/question snapshot and knowledge revision. `supplier_sent` was false. Same-tab refresh restoration was observed. [Receipt evidence](2026-11-19-decision-flow/local-browser-receipt.json)

Minimal successful receipts use session storage; contacts and raw conversations are not retained there. Restored downloads contain the receipt only, and “Prepare another enquiry” clears it. This does not recover unacknowledged requests after refresh or provide cross-device access. DNT/GPC suppresses attribution; successful submission clears journey state. Same-key retries, legacy hashes and reordered-question replay passed real-SQLite tests. Snapshots retain their submission-time revision; public/private visibility changes can produce another knowledge revision.

[Migration 0002](../../drizzle/0002_enquiry_context.sql) adds four nullable columns and an index without inventing historical attribution. **Apply it after 0000/0001 before switching the new Worker**, whose enquiry/feedback queries require these columns. Local compatibility and production migration were verified; native D1 read-back confirmed all four columns and preservation of both legacy rows.

## Enterprise scope and external limits

The three fixtures—`synthetic-cotton-textiles` (5 pages), `synthetic-industrial-testing` (4), and `synthetic-empty-catalog` (3)—passed actual check/build/output and durable private-worker acceptance as **`STATIC_PASS_BROWSER_NOT_TESTED`**. They remain isolated private previews with fallback art; `production_deployed:false`, `live_enterprise_ingestion:NOT_TESTED`. Runs preceded final cosmetic mobile polish. The current enterprise Playwright suite was not executed. [Report](2026-11-19-decision-flow/builder-acceptance.json), [log](2026-11-19-decision-flow/builder-acceptance.log)

**Live sourcing model, paid image/vision providers, Google Search Console and Umami remain unconfigured/unconnected.** Source search is keyword retrieval, not a generated answer. The feedback API is owner-authenticated; no automatic consumer or content-publication loop is claimed. Article selection is brief context, and landing/campaign labels are browser-reported—not causal attribution. QA traffic is not buyer demand; no supplier contact, confirmed quotation or order occurred. [Runtime contract](../../runtime/README.md)

## Hosted release and D1 acceptance

**Version 4 deployed successfully** at https://buyersite.magicy565.chatgpt.site/ from source commit `0728ea64bb00f261404b9ccc0815bc380febc3eb`. The approved code fingerprint remains `76fdf7b32ede89a993d33e28c57b2e3c759d6d8fbf8289646035ac2a51c97272`. Subsequent evidence-only source saves do not change this reviewed application code.

| Hosted check | Observed result |
| --- | --- |
| Deployment | Succeeded: `appgdep_6afdd7ed68f481918893cdec23fc8cc8` |
| Migration | All four 0002 columns present; both historical archived rows retained with null legacy context |
| Browser enquiry | Receipt `75891cf5-889d-48c1-b597-773cf972f7ce` displayed and restored after reload |
| Native D1 read-back | Exactly one matching row, canonical article, landing page, selected technical-sheet question, source IDs and public knowledge revision all stored |
| Public capabilities | Enquiries and source guide enabled; live assistant explicitly false |
| Public knowledge | HTTP 200; revision matches the locally packaged public artifact |
| Scoped source lookup | HTTP 200; width query returns the material's exact 140 cm value and original source |
| Public controls | Robots and sitemap HTTP 200; unauthenticated enquiry/admin-feedback APIs HTTP 401 |

Evidence: [hosted release and database read-back](2026-11-19-decision-flow/hosted-v4-acceptance.json), [API verification](2026-11-19-decision-flow/hosted-api-readback.json), [published homepage](2026-11-19-decision-flow/screenshots/public-home.jpg), [restored hosted receipt](2026-11-19-decision-flow/screenshots/public-restored-receipt.jpg).

The new QA row is explicitly labelled synthetic and **remains new, not archived or qualified**. The existing owner token was unavailable to this verification session; it was not rotated. Consequently the hosted authenticated aggregate API, same-key replay of the browser-generated request, and administrative archival were not re-tested. Native owner-authorized database read-back independently proves storage. The bounded database read contained zero qualified enquiries. The synthetic record and review traffic must not be reported as acquired customers or demand. Local real-SQLite tests cover idempotency and the new aggregate dimensions.

Earlier [11-18 hosted acceptance](2026-11-18-launch.md) remains historical evidence for the previous version and does not replace the current migration/context verification.
