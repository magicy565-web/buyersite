# Buyer conversion adapter

The Astro magazine stays static. `createGateway(config)` wraps its asset binding with a small same-origin API. It stores buyer intent and optionally connects the existing OpenMausBot sourcing gateway. It does not create another agent, supplier messaging service or operations dashboard.

This is the conversion and feedback layer of the [three-stage site architecture](../README.md#three-stage-architecture). The supported live-AI path is currently unconfigured. Source-fact search and enquiry storage operate independently of model credentials. Google Search Console and Umami are not connected; first-party aggregate event counts are not external analytics or search-index verification.

## Bindings and build configuration

- `DB`: a D1 binding with the schema in `drizzle/0000_buyer_enquiries.sql` applied before deployment. Never run schema changes in a request handler.
- `ASSETS`: the static Astro build.
- `config.siteSlug`: server-owned edition identifier. `allowedPaths` is the build's public route inventory. `enquiriesEnabled` is false for synthetic/private enterprise preview editions unless explicitly enabled by the release configuration.
- `BUYERSITE_ADMIN_TOKEN`: optional server secret of at least 32 characters for the owner review API. Without it that API returns 401. The authenticated Sites database tools remain available to the owner.
- `BUYERSITE_SOURCING_URL` and `BUYERSITE_SOURCING_TOKEN`: optional server-only existing gateway configuration. The HTTPS base may include a path prefix, but no credentials, query or fragment. The token must be at least 16 characters. No API keys or tokens enter the browser bundle.

`handleBuyerRequest(request, env, config)` returns `null` for non-buyer API paths, so the hosting entry can route analytics separately.

## Visitor API

`GET /api/buyer/config` reports live capabilities. A configured database enables the requested inbox; live AI requires both the sourcing base and token. Missing configuration leaves a working source-guide/search/enquiry-draft path and never fabricates an AI answer.

`POST /api/buyer/enquiries` accepts an explicit consented brief, email, optional name/company and limited campaign labels. It requires a UUID v4 `Idempotency-Key` and same-origin request. It validates body size, source route and field limits. A durable unique key avoids duplicate leads on a network retry; reusing a key with changed fields returns 409. D1 atomically caps submissions at five per source-address bucket per hour. Raw IP addresses are not stored.

A successful response contains a stable receipt and `destination: "buyersite-editorial-inbox"`, `supplier_sent: false`. This confirms that the brief exists in the inbox, not a supplier quote, delivery commitment or message dispatch. The browser preserves the draft after errors and provides a local text download without collecting email when the inbox is unavailable.

`POST /api/buyer/assistant` accepts a question and a known public page. The adapter expects an upstream implementing `/v1/public-sites/:siteSlug/sessions` and `/chat`. No deployed OpenMausBot service has yet been verified against that REST contract; its documented magazine MCP endpoint is not a substitute. Provider sessions are stored server-side, bound to the edition and one-hour expiry; the browser receives a separate random session reference. Question text is not stored by this adapter. The configured sourcing service's handling applies to questions sent to it. No supplier contact or order action is exposed through this endpoint.

## Owner review

`GET /api/buyer/admin/enquiries` with `Authorization: Bearer …` returns at most 50 records for this edition. Pass its opaque `next_cursor` as the next request's `cursor` query parameter; the timestamp/ID pair preserves records received in the same millisecond. `PATCH /api/buyer/admin/enquiries/:id` accepts only `{"status":"new"}`, `qualified` or `archived`. Responses never expose credentials, idempotency keys or hashes. No public list/detail API is available.

## Aggregate editorial feedback

`GET /api/buyer/admin/feedback?days=30` uses the same owner bearer token and returns `buyer-feedback-v1` for the server-owned edition. The window is 1–90 UTC calendar days, includes the current partial day, and defaults to 30 days. It is an input for the existing OpenMausBot editorial workflow; it creates no separate dashboard or agent.

The response contains browser-reported action counts by day/event/path and authoritative totals from saved enquiry rows by current status, day and source page. `new`, `qualified` and `archived` describe current owner review state for enquiries created in the selected period. A `qualified` enquiry is not an order. The client `enquiry_submitted` event cannot increase the persisted enquiry totals. Repeated page views are action counts, not unique visitor measurements. A form's saved path does not prove which article originally acquired the buyer.

Only aggregate columns are selected: no email, name, company, free-text brief, upstream session, idempotency token or hash leaves this endpoint. Result lists are bounded to 20,000 event rows and 5,000 enquiry-page rows and expose truncation flags; period totals still cover all matching rows. Queries run in a D1 batch for a consistent read. Apply `drizzle/0001_buyer_events.sql` along with the enquiry schema before using feedback.

## Source guide without a model connection

The sourcing dialog offers a working source-fact search when live AI is not configured. `POST /api/buyer/source-guide` accepts a query of at most 200 characters and the current `site_slug`. It performs bounded keyword matching over `config.sourceRecords`, which the release builder must derive exclusively from evidence already published in this edition. Each record has `id`, `title`, `claim`, `value`, `source_url`, `page_path`, `status` and `captured_at`.

Results copy up to five matching facts verbatim from that approved record set and link both the article and the original source. Unknown prices, certifications or commercial terms produce no inferred answer. The response and interface explicitly identify keyword source search, not AI generation. Queries are not persisted or sent to a model. Extra internal fields are excluded from responses, and records outside the allowed route inventory or without an HTTPS citation are not returned. The capability remains useful without model credentials; unavailable source configuration falls back to edition search and reading links.

## Build and deployment

From the repository root, use Node 24 and the pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm test:runtime
pnpm check
pnpm build
pnpm verify:output
pnpm check:release
```

`pnpm build` generates the edition route/source inventory and bundles `runtime/index.mjs` to `dist/server/index.js`; static content and Pagefind assets live in `dist/client/`. `pnpm dev --port 4321` serves this built Worker with local SQLite for development. Production uses the Site's D1 database, with the committed SQL migrations applied by the deployment workflow. Local SQLite contents are not deployed.

Use the existing Site identity in `.openai/hosting.json`, save a version of the exact pushed source and matching build, then deploy that saved version through the Sites workflow. Runtime secrets are optional capabilities: an admin token enables owner API access; an upstream URL/token pair enables the existing AI service. Keep the owner token outside browser code and configure it for the existing worker that consumes feedback. The endpoint is not publicly readable and has no separate dashboard. See the [release checklist](../README.md#deploy-the-reviewed-source) for the complete site gates.

## Verification

Run `node --test runtime/*.test.mjs` on Node 24. Gateway tests apply the real SQL to an on-disk SQLite database, reopen it to check persistence, and exercise consent, origins, idempotency, abuse limits and owner authorization. Feedback and analytics tests apply both migrations to real SQLite databases to check aggregation, date boundaries, edition isolation, contact exclusion, origin validation and tracking opt-outs. The sourcing-service test explicitly uses a mocked HTTP upstream and does not prove live provider credentials or a model call. Browser checks and hosted D1 acceptance belong to deployment verification.
