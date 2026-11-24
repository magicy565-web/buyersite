# Merchant support integration runbook

## Deployment state

The integration branch is a private, reviewable build. `src/data/publication.json`
uses `mode: "private"` because the existing public approval does not cover this new
source tree. No review fingerprint is forged or silently refreshed. Keep public
customer endpoints disabled until the exact source and real merchant connections
have passed acceptance.

This repository provides a runnable Worker, schemas, CLI and provider contracts.
It does not provision a Chatwoot account, identity provider, model endpoint or native
Business Hub approval. Configuration status is never displayed as live verification.

## Required server settings

| Variable | Purpose |
| --- | --- |
| `BUYERSITE_MERCHANT_SUPPORT_ENABLED=true` | Explicitly enables the unified merchant subsystem |
| `BUYERSITE_MERCHANT_CONFIG` | JSON binding described below; one merchant per edition |
| `BUYERSITE_ADMIN_TOKEN` | Existing BuyerSite owner credential, at least 32 characters |
| `BUYERSITE_MERCHANT_OWNER_ID` | Server-configured audit identity for owner mutations |
| `BUYERSITE_CHATWOOT_ENABLED=true` | Separately allows the website widget |
| `BUYERSITE_CHATWOOT_WEBSITE_TOKEN` | Public Website Inbox widget token |
| `BUYERSITE_CHATWOOT_API_TOKEN` | Service-user token allowed to create API Inbox contacts/conversations and list messages |
| `BUYERSITE_CHATWOOT_AGENTBOT_TOKEN` | AgentBot API token; separate from the service-user token |
| `BUYERSITE_CHATWOOT_AGENTBOT_ID` | Positive numeric ID of the expected bot |
| `BUYERSITE_CHATWOOT_WEBHOOK_SECRET` | Signing secret, at least 32 characters, provisioned from the supported Chatwoot integration |
| `BUYERSITE_MERCHANT_OAUTH_ISSUER` | Exact configured identity-provider issuer |
| `BUYERSITE_MERCHANT_OAUTH_JWKS_URI` | Explicit trusted HTTPS JWKS URI; never taken from a token |
| `BUYERSITE_MERCHANT_ANSWER_URL` | Optional full HTTPS URL implementing `buyersite-merchant-answer-v1` |
| `BUYERSITE_MERCHANT_ANSWER_TOKEN` | Optional answer-provider token, at least 32 characters |

Binding template; replace every example with the merchant's actual authorized values:

```json
{
  "version": 1,
  "authorized": true,
  "merchantId": "merchant-a",
  "siteSlug": "material-notes",
  "name": "Authorized merchant name",
  "origin": "https://merchant.example",
  "privacyUrl": "https://merchant.example/privacy",
  "authorizationRef": "internal-authorization-record-reference",
  "chatwoot": {
    "baseUrl": "https://support.example",
    "accountId": 1,
    "websiteInboxId": 2,
    "apiInboxId": 3
  }
}
```

`origin` must equal the edition's configured publication origin. IDs are examples,
not provisioned resources. An optional `knowledgeRevision` pins a 64-character
SHA-256 knowledge version. Public knowledge reads respect the pin. Rotating merchant
authorization or Chatwoot coordinates invalidates old private support threads.
Private conversations are not automatically merged across website and ChatGPT channels.

The unified binding takes precedence whenever its configuration or enable flag is
present. The legacy PR #19 widget variables still work only when the unified
configuration is entirely absent. Setting the unified flag false closes that widget.

## Database and verification

Apply Drizzle migrations `0000` through `0006` in journal order to a staging D1
database. Use the migration runner's journal; do not replay unjournaled `ALTER TABLE`
statements manually. `0003`/`0004` reuse the existing branch migrations;
`0005` registers the existing sourcing-session schema. `0006` contains all new
merchant tables and immutable audit/version constraints.

```bash
pnpm install --frozen-lockfile
pnpm merchant:migration
pnpm check:merchant-migration
pnpm test:merchant
pnpm test:runtime
pnpm test:knowledge
pnpm test:site-builder
pnpm check
pnpm build
pnpm test:browser
```

`merchant:migration` only regenerates the checked-in SQL from schema fragments;
it never connects to a database. Commit the generated file and its reviewed source
fragments together. Development preview uses local SQLite; production uses hosted D1.

## Endpoint inventory

| Route | Access | Behavior |
| --- | --- | --- |
| `GET /api/buyer/support/config` | Public edition | Minimal website widget configuration |
| `GET /api/buyer/support/merchant` | Public edition | Merchant identity and configured capabilities |
| `POST /api/buyer/support/webhook` | Valid Chatwoot HMAC | Bounded, durable AgentBot intake |
| `POST /mcp` | Per-tool OAuth | Stateless JSON Streamable HTTP MCP |
| `GET /.well-known/oauth-protected-resource/mcp` | Public edition | Exact MCP resource and issuer metadata |
| `GET /.well-known/oauth-protected-resource` | Public edition | Same resource metadata |
| `GET /api/buyer/admin/merchant-support` | Owner token | Configuration, knowledge, claim and delivery diagnostics |
| `POST /api/buyer/admin/merchant-support/knowledge` | Owner token and configured actor | Save immutable approved facts; does not activate them |
| `POST /api/buyer/admin/merchant-support/knowledge/activate` | Owner token and actor | Activate with expected-revision CAS |
| `GET /api/buyer/admin/merchant-support/claim-pack` | Owner token | Prepare native Business Hub materials from current facts |
| `POST /api/buyer/admin/merchant-support/claim-evidence` | Owner token and actor | Record observed evidence and expected-revision CAS |
| `POST /api/buyer/admin/merchant-support/drain` | Owner token and actor | Process one durable job; send `{}` |
| `POST /api/buyer/admin/merchant-support/reconcile` | Owner token and actor | Resolve one uncertain support receipt using scoped evidence; never resends |

All endpoints are bound to the canonical HTTPS origin; forwarded host headers do
not choose a tenant. MCP/public API routes and owner responses are `no-store` and
`noindex`. The owner CLI is described in [OWNER-CLI.md](./OWNER-CLI.md).

## Queue scheduling and alerts

Configure the Chatwoot AgentBot outgoing URL as the canonical webhook route.
The webhook verifies timestamp and exact raw-body HMAC before parsing. A 202 means
the job was stored, not that an answer was sent. Intake performs no model calls.
Where the host supports `ctx.waitUntil`, it starts one background drain after durable
acceptance. The Worker also exports `scheduled` to process at most three jobs per tick.

The repository's existing hosting configuration does not provision a cron trigger.
The deployment must attach a supported scheduler to the Worker `scheduled` handler,
or run an authenticated job that POSTs `{}` to the owner `/drain` endpoint. Configure
that job in the server environment; do not expose its owner token to ChatGPT or the
browser. A one-minute cadence is a starting operational choice, not a provisioned job.
Without a scheduler, process crashes and retry backoff need manual draining.

Monitor counts of queued, processing, unknown and dead jobs, and uncertain support
operations from owner diagnostics. An external monitor must alert an actual operator;
this delivery does not invent an email/Slack notification destination. Confirm the
alert reaches that operator during staging. Jobs older than 24 hours go to human
handoff instead of generating stale automatic answers.

## Knowledge and answer behavior

Approve real merchant-owned public facts, save them, then activate their revision.
Publication permission is separate from independent verification. Price, availability,
MOQ, lead time and certification require expiry. Ordinary sourcing evidence from the
existing magazine is not automatically authorized to represent the merchant.

The public knowledge tool returns exact stored facts, sources and dates. The answer
provider receives an explicit merchant binding and approved snapshot. For commercial
questions or commitments, an automatic answer must exactly match a current explicitly
confirmed commercial fact. Otherwise the bot requests human support. Low confidence,
unsupported claims, attachments, missing provider, expired evidence or stale knowledge
revision also lead to handoff. Active knowledge is checked again before sending.

The current bot supports at most 500 active facts and a bounded provider request.
Larger bundles remain searchable through the public tool, while automatic answers
fall back to human support. A future retrieval projection must retain general merchant
policies as well as relevant facts; it must not silently discard restrictions.

## Delivery, recovery and data

Buyer messages are forwarded only after explicit sharing consent and OAuth write scope.
The service creates opaque contact identities and stores issuer/subject hashes, private
thread IDs, original binding hashes, consent, operation hashes and delivery receipts.
Thread access expires after 30 days. Raw ChatGPT transcripts are never accepted as an
implicit conversation context. Only the selected message is forwarded.

The AgentBot queue temporarily stores the bounded incoming message and generated answer
needed for durable processing; it excludes email, phone and full conversation history.
Each scheduled or explicit queue drain also redacts up to 500 completed, unknown or
dead jobs whose last update is at least 30 days old. It preserves their status, IDs,
hashes and deduplication records, so uncertain delivery remains blocked. Active queue
jobs are preserved for processing. Configure Chatwoot/provider retention
under the merchant's actual policy. These are separate stores; removing a BuyerSite
record is not a claim that the upstream record was deleted.

Chatwoot message creation has no guaranteed idempotency contract. A timeout after an
external write therefore produces `uncertain`; the same request key returns the saved
receipt, and another write in that thread is blocked. Do not blindly resend with a new
key. Owner reconciliation validates observed delivery against the bound conversation
and message, or records an explicit operator assertion of non-delivery. Audit evidence
is immutable. A negative decision never sends the message automatically.

Human requests set a durable local automation stop even when another message is
uncertain. Chatwoot `open` means queued for human support; it does not mean a person
has joined. There remains a small upstream GET-to-POST takeover race because Chatwoot
does not provide a conditional reply-create operation. The local stop, queue lease,
latest knowledge and remote assignment are checked immediately before sending.

## Official claim and ChatGPT installation

Use `claim-pack` to produce the merchant's public material, then follow the actual
[Business Hub flow](https://help.openai.com/en/articles/20001635-setting-up-your-business-on-chatgpt).
Do not upload identity documents or DNS verification secrets into this service.
Record only opaque evidence references and hashes after observing the official state.
Claim, Persona verification, agent preview and agent publication are separate records;
the internal state always says `owner_recorded` and `platform_verified: false`.

For direct support in ChatGPT, configure a real OAuth 2.1 identity provider with
PKCE S256 and exact resource audience `<merchant-origin>/mcp`. This Worker verifies
RS256 access tokens from its explicit JWKS endpoint; it is not an authorization server.
Use the two scopes `merchant:support:read` and `merchant:support:write`.
Follow the [Plugin channel guide](../CHATGPT-MERCHANT-CHANNEL.md) for registration and
real-client acceptance. No automatic installation, official approval or public listing
is implied by the five MCP tool implementations.
