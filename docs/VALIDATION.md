# Validation — 2026-11-12

Historical record for the original real-source pilot. For the current enterprise
builder, use the [2026-11-14 reproduction report](verification/2026-11-14-reproduction.md):
exact Node/pnpm locked installation, three synthetic editions and 96 browser
tests passed. The pilot-specific results below are not a live enterprise or
production acceptance and have not been re-labelled as such.

Executed locally with Node 24.22.1, pnpm runner 11.25.0 and Astro 7.3.3.

## Passed

- Frozen dependency installation after explicitly allowing the normal esbuild and sharp package build scripts.
- Astro type check: 43 files, zero errors/warnings/hints.
- Production static build: ten pages, optimized supplier product imagery and self-hosted fonts.
- Content checks: original JSON schemas validate one manifest, four page contracts and six source-backed evidence records; evidence cross-references and Markdown/contract drift are checked.
- Built output: four core routes have exactly one H1 matching the contract, canonical and noindex; product specification summary precedes the article body; article source notes include the corresponding claim, value and source link; robots disallows all, sitemap exists, enquiry page explains that nothing is sent.
- Original theme colour-token contrast checker: all listed light/dark pairs pass.
- ESLint and git diff whitespace checks.
- Playwright test discovery: 15 cases across desktop, 390 px and 360 px. Discovery only; browser execution is NOT PASSED.

## Not accepted

- Desktop/mobile rendering, overflow, dialog keyboard behaviour and downloaded brief have not been browser-accepted. The current environment again rejected Chromium startup because process-singleton socket creation was not permitted. The running browser also rejected local file URLs through its URL security policy; no alternate file-access route was attempted after that rejection. No visual pass, screenshots or Lighthouse score is claimed. See BROWSER-ACCEPTANCE.md for the supported-environment run procedure.
- No live gateway: sessions, JSON chat protocol, tenant isolation, grounded answers and errors need a real service test. The default UI visibly reports that AI is disconnected.
- No durable RFQ API, supplier notification, real buyer visit or conversion.
- No public deployment; no indexing, crawler access, Core Web Vitals or GEO acceptance. The .invalid canonical base and noindex/robots lock intentionally describe a private review build.
- Supplier facts are self-reported and not independently verified; commercial terms remain unknown. Supplier imagery has not been cleared for public marketing.

The contracts are a validated export projection for this pilot; a general JSON-to-theme compiler remains future work. Legacy skills are reference files, not installed personal skills or a DSH plugin.
