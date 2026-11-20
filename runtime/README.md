# Buyer conversion adapter

The Astro magazine stays static. `createGateway(config)` wraps its asset binding with a small same-origin API. It stores buyer intent and optionally connects the existing OpenMausBot sourcing gateway. It does not create another agent, supplier messaging service or operations dashboard.

This is the conversion and feedback layer of the [three-stage site architecture](../README.md#three-stage-architecture). The supported live-AI path is currently unconfigured. Source-fact search and enquiry storage operate independently of model credentials. Google Search Console and Umami are not connected; first-party aggregate event counts are not external analytics or search-index verification.

## Bindings and build configuration

- `DB`: a D1 binding with the committed migrations `0000_buyer_enquiries`, `0001_buyer_events`, `0002_enquiry_context` and `0003_marketing_outbox` applied in order before deployment. Never run schema changes in a request handler. Migration 0002 adds nullable context/landing fields and an origin index; it does not invent a historical article or campaign for older enquiries.
- `ASSETS`: the static Astro build.
- `config.siteSlug`: server-owned edition identifier. `allowedPaths` is the build's public route inventory. `enquiriesEnabled` is false for synthetic/private enterprise preview editions unless explicitly enabled by the release configuration.
- `config.buyerBriefs` and `config.knowledgeRevision`: the same published article catalog and revision used for `/buyer-data.json`, source-backed brief preparation and article links. Each brief includes `page_path`, `title`, `summary`, `product_name`, nullable public product/supplier/source identifiers, `evidence_ids`, `unconfirmed: [{id,label,detail}]` and `questions: [{id,label,prompt}]`. These public build records, not browser assertions, determine saved context.
- `BUYERSITE_ADMIN_TOKEN`: optional server secret of at least 32 characters for the owner review API. Without it that API returns 401. The authenticated Sites database tools remain available to the owner.
- `BUYERSITE_SOURCING_URL` and `BUYERSITE_SOURCING_TOKEN`: optional server-only existing gateway configuration. The HTTPS base may include a path prefix, but no credentials, query or fragment. The token must be at least 16 characters. No API keys or tokens enter the browser bundle.

`handleBuyerRequest(request, env, config)` returns `null` for non-buyer API paths, so the hosting entry can route analytics separately.

## Visitor API

`GET /api/buyer/config` reports live capabilities. A configured database enables the requested inbox; live AI requires both the sourcing base and token. Missing configuration leaves a working source-guide/search/enquiry-draft path and never fabricates an AI answer.

`POST /api/buyer/enquiries` accepts an explicit consented brief, email, optional name/company and limited campaign labels. It requires a UUID v4 `Idempotency-Key` and same-origin request. It validates body size, source route and field limits. A durable unique key avoids duplicate leads on a network retry; reusing a key with changed fields returns 409. D1 atomically caps submissions at five per source-address bucket per hour. Raw IP addresses are not stored.

A successful response contains a stable receipt and `destination: "buyersite-editorial-inbox"`, `supplier_sent: false`. This confirms that the brief exists in the inbox, not a supplier quote, delivery commitment or message dispatch. The browser preserves the draft after errors and provides a local text download without collecting email when the inbox is unavailable.

### Context, attribution and browser storage

Article CTAs carry only `/enquiry?from=<canonical article path>` and, optionally, `question=<published question ID>`. The form resolves both against its published catalog, exposes the chosen article and questions, and allows a general enquiry or another article. Product, quantity, application and delivery fields remain editable. The form posts `context_page_path`, `question_ids`, optional `landing_page_path`, `attribution: {source?,medium?,campaign?}` and `attribution_opt_out`, alongside the existing brief/contact fields and explicit consent.

The server independently resolves the article and selected question IDs; browser-supplied product/supplier/source/evidence identifiers are rejected. `context_json` snapshots the published product/source IDs, evidence references, unknown conditions, selected question text and knowledge revision. `originating_page_path` identifies the selected article; `page_path` remains the form's submission page. That selected context is a reference for the buyer's request, not evidence that the buyer read the article or that it caused an acquisition. Request digests use normalized article paths and sorted question IDs, so later headline or question-order edits cannot duplicate an accepted enquiry. The first saved snapshot is retained. Legacy request hashes remain replayable.

`buyersite:journey:v1:<site>` in `sessionStorage` holds the first known landing path, latest known article and bounded campaign labels across internal navigation. Labels use only letters, digits, hyphens or underscores, start with a letter, and are capped at 32 characters for source/medium and 64 for campaign; long numeric identifiers, URLs, email addresses and free text are rejected or omitted. These are browser-reported values, not independently verified acquisition data. No full query string, referrer, visitor ID, contact or search text is stored or sent in event logs. DNT/GPC clears journey data and suppresses analytics/attribution; the buyer's explicitly chosen article still accompanies the functional brief. Buyers can remove visit context, and successful submission clears it.

An explicit assistant handoff writes `buyersite:brief:v1` once, containing only `{version:1,site_slug,page_path,question_ids,requirements:{quantity?,application?,delivery?}}`. It is catalog-validated, consumed on the enquiry page and remains editable. It contains no chat transcript or contact details. A successful receipt stores only `{site_slug,receipt_id,created_at,status,destination,supplier_sent}` under `buyersite:receipt:v1:<site>`. Same-tab refresh restores a receipt-only view; its download explicitly omits the unretained original brief. “Prepare another enquiry” clears that receipt. Browser storage denial leaves the live form usable but disables restoration. These session values are not placed in cookies or `localStorage`.

`POST /api/buyer/assistant` accepts a question and a known public page. The adapter expects an upstream implementing `/v1/public-sites/:siteSlug/sessions` and `/chat`. Its `product_context` comes from the selected server-owned brief, including public IDs, approved source facts, unconfirmed terms, published questions and knowledge revision; arbitrary browser context is ignored. No deployed OpenMausBot service has yet been verified against that REST contract; its documented magazine MCP endpoint is not a substitute. Provider sessions are stored server-side, bound to the edition and one-hour expiry; the browser receives a separate random session reference. Question text is not stored by this adapter. The configured sourcing service's handling applies to questions sent to it. No supplier contact or order action is exposed through this endpoint.

## Owner review

`GET /api/buyer/admin/enquiries` with `Authorization: Bearer …` returns at most 50 records for this edition. Pass its opaque `next_cursor` as the next request's `cursor` query parameter; the timestamp/ID pair preserves records received in the same millisecond. `PATCH /api/buyer/admin/enquiries/:id` accepts only `{"status":"new"}`, `qualified` or `archived`. Responses never expose credentials, idempotency keys or hashes. No public list/detail API is available.

## Aggregate editorial feedback

`GET /api/buyer/admin/feedback?days=30` uses the same owner bearer token and returns `buyer-feedback-v1` for the server-owned edition. The window is 1–90 UTC calendar days, includes the current partial day, and defaults to 30 days. It is an input for the existing OpenMausBot editorial workflow; it creates no separate dashboard or agent.

The response contains browser-reported action counts by day/event/path and authoritative totals from saved enquiry rows by current status, day and submission page. Additive `by_originating_article`, `by_landing_page`, `by_campaign` and `by_attribution_method` groups separate selected reference context from browser-reported attribution. Null article/landing and empty campaign labels remain unattributed; legacy unsafe campaign labels are suppressed. `new`, `qualified` and `archived` describe current owner review state for enquiries created in the selected period. A `qualified` enquiry is not an order. The client `enquiry_submitted` event cannot increase persisted enquiry totals. Repeated page views are action counts, not unique visitor measurements.

Only grouped columns are selected: no email, name, company, free-text brief, upstream session, idempotency token or hash leaves this endpoint. Result lists are bounded to 20,000 event rows and 5,000 rows per enquiry dimension and expose truncation flags; period totals still cover all matching rows. Queries run in a D1 batch for a consistent read. This authenticated API is available for an existing workflow to consume; no scheduled feedback consumer is configured by this implementation.

## Source guide without a model connection

The sourcing dialog offers a working source-fact search when live AI is not configured. `POST /api/buyer/source-guide` accepts a query of at most 200 characters, the current `site_slug` and an optional known `page_path` to scope results to the chosen article. It performs bounded keyword matching over `config.sourceRecords`, which the release builder must derive exclusively from evidence already published in this edition. Each record has `id`, `title`, `claim`, `value`, `source_url`, `page_path`, `status` and `captured_at`.

Results copy up to five matching facts verbatim from that approved record set and link both the article and the original source. Unknown prices, certifications or commercial terms produce no inferred answer. The response and interface explicitly identify keyword source search, not AI generation. Queries are not persisted or sent to a model. Extra internal fields are excluded from responses, and records outside the allowed route inventory or without an HTTPS citation are not returned. The capability remains useful without model credentials; unavailable source configuration falls back to edition search and reading links.


## MausBot Growth Marketing attribution bridge

The Buyer Site can forward **campaign-attributed aggregate events** to the existing OpenMausBot Growth Marketing Department. This is a server-to-server bridge, not a new CRM, analytics vendor or supplier messaging service.

### Connection

1. In the MausBot workspace, the owner calls `POST /api/marketing/webhook/rotate` while the public webhook ingress is reachable over HTTPS. The response returns the exact `/marketing/events/{tenantId}` endpoint and a one-time HMAC secret. Store the secret securely; it is not retrievable after the response.
2. Configure these server-only Worker secrets:
   - `MAUSBOT_MARKETING_WEBHOOK_URL`: the exact HTTPS endpoint returned by MausBot.
   - `MAUSBOT_MARKETING_WEBHOOK_SECRET`: the one-time secret returned by MausBot (minimum 32 characters).
3. Apply migration `0003_marketing_outbox` to the same D1 database used by this edition.
4. Configure a Cloudflare Worker Cron Trigger such as `*/5 * * * *` so the exported `scheduled` handler retries pending deliveries. Immediate delivery is attempted with `ctx.waitUntil`; the durable outbox and scheduled trigger recover transient failures, worker restarts and timeouts.

The owner-only `GET /api/buyer/admin/feedback?days=30` response includes `marketing_delivery` with `connection`, `pending`, `sending`, `delivered` and `dead` counts. `needs_connection` means no valid endpoint/secret pair is configured. Pending does not mean delivered.

### Event and privacy contract

- A browser-reported event is forwarded only when the session's bounded `utm_campaign` equals a canonical MausBot Campaign ID (`cmp_<uuid>). The campaign ID is carried with `utm_source` and `utm_medium` in first-party session storage; it is not inferred from a free-text label.
- `page_view` becomes `landing_view` on the original tagged landing path and `page_view` on later pages. `assistant_opened` and `enquiry_started` become `cta_click`. The browser's `enquiry_submitted` event is **not** trusted for conversion counting.
- `inquiry_submitted` is enqueued only after D1 has durably accepted the consented enquiry. The outbox includes the opaque enquiry receipt ID, campaign, timestamps, bounded source labels and page paths only. It never sends email, name, company, product requirements, free-text application, chat transcript, raw IP, session ID or visitor ID.
- DNT/GPC and the buyer's explicit attribution opt-out suppress marketing attribution while leaving the enquiry flow available. Organic/unattributed visits are not silently assigned to a paid campaign.
- Each outbox item is signed as HMAC-SHA256 over `timestamp + "." + rawBody`, sent in `X-Maus-Timestamp` and `X-Maus-Signature`. MausBot acknowledges durable persistence with HTTP 202. Retries reuse the same event ID; MausBot deduplicates them. A mismatched replay payload is rejected rather than reassigned.
- The outbox never claims supplier contact, quote delivery, an order or revenue. The Buyer Site's existing enquiry receipt still states `supplier_sent:false`; routing buyer contact details to the virtual Sales/Sourcing department is a separate, consented integration.

If the endpoint is missing, malformed or not HTTPS, the outbox remains pending and the status is `needs_connection`; it never reports a successful handoff. If a provider returns a permanent 4xx, the item moves to `dead` for owner review rather than being retried forever.

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

Run `node --test runtime/*.test.mjs` on Node 24. Gateway tests apply real SQL to an on-disk SQLite database, reopen it to check persistence, and exercise context tampering, campaign bounds, privacy opt-outs, consent, origins, legacy and contextual idempotency, abuse limits and owner authorization. Feedback tests apply all three migrations to real SQLite and check aggregate dimensions, date boundaries, edition isolation and contact exclusion. Journey tests cover session navigation, one-use drafts, receipt restoration and malformed/cross-edition storage. Analytics tests check aggregation, origin validation and tracking opt-outs. The sourcing-service test explicitly uses a mocked HTTP upstream and does not prove live provider credentials or a model call. Browser checks and hosted D1 acceptance belong to deployment verification.
