# ChatGPT merchant support channel

This channel exposes a real resource-server boundary between ChatGPT and a single
BuyerSite merchant's customer-support service. It uses Streamable HTTP with JSON
responses and an existing OAuth 2.1 identity provider. It does not issue tokens,
claim a merchant, create fake customer identities, or generate merchant replies.

`runtime/merchant-mcp.mjs` implements MCP transport and tool dispatch.
`runtime/merchant-oauth.mjs` verifies RS256 JWT access tokens with Web Crypto and
the operator's configured JWKS endpoint. Neither module adds a package dependency.
Both use standard Fetch APIs and are tested with Node 24.

## Integration and exports

Create the verifier once per configured issuer/resource, then create an MCP
handler for the server-resolved merchant. Reuse the verifier to preserve bounded
JWKS caching. Resolve the merchant from the trusted site's server configuration;
never select a merchant, issuer, signing-key URL, or Chatwoot inbox from tool input.

```js
import { createMerchantOAuthVerifier } from './merchant-oauth.mjs';
import { createMerchantMcp } from './merchant-mcp.mjs';

const resource = 'https://merchant.example.com/mcp';
const authorizationServer = 'https://identity.example.com';

const verifyAccessToken = createMerchantOAuthVerifier({
  issuer: authorizationServer,
  audience: resource,
  jwksUri: 'https://identity.example.com/.well-known/jwks.json',
});

const mcp = createMerchantMcp({
  resource,
  authorizationServer,
  merchantId: merchantBinding.merchantId,
  verifyAccessToken,
  service: merchantSupportService,
});

// Route the exact MCP path and the resource-metadata paths to this handler.
return mcp.fetch(request);
```

The snippet illustrates composition: `merchantBinding` and
`merchantSupportService` must come from the application's server-side binding and
persistent support service. The modules alone do not provision a Chatwoot inbox,
configure an identity provider, or publish a ChatGPT plugin.

### `createMerchantMcp(options)`

| Option | Contract |
| --- | --- |
| `resource` | Canonical HTTPS MCP URL, including a non-root path; no query, fragment, or credentials. The same exact URL is the OAuth audience. |
| `merchantId` | Server-bound lowercase ID matching `^[a-z0-9][a-z0-9_-]{0,79}$`. |
| `authorizationServer` | Exact OAuth issuer string, or `null` to disable private support. |
| `verifyAccessToken` | Async `(token, requiredScopes) => { issuer, subject, scopes }`; use the real verifier below. Must be `null` when the authorization server is `null`. |
| `service` | The persistent support-service methods listed below. |
| `allowedOrigins` | Optional exact HTTPS browser origins. The resource origin is always allowed. Requests without `Origin` are supported for server clients. |

Returns the immutable object `{ fetch, metadataUrl, resource, tools }`.
`fetch` accepts a standard `Request` and resolves to a `Response`.

Other exports:

- `MERCHANT_MCP_PROTOCOL_VERSION`: `2025-11-25`.
- `MERCHANT_SUPPORT_CONSENT_VERSION`: `merchant-support-v1`.
- `MERCHANT_SUPPORT_SCOPES`: `merchant:support:read`, `merchant:support:write`.

### `createMerchantOAuthVerifier(options)`

| Option | Default and contract |
| --- | --- |
| `issuer` | Required exact HTTPS issuer. |
| `audience` | Required exact HTTPS resource identifier. |
| `jwksUri` | Required operator-configured HTTPS signing-key endpoint; redirects are rejected. |
| `fetchFn` | Global `fetch`; injectable for tests or controlled network transport. |
| `now` | `Date.now`; returns Unix milliseconds. |
| `cacheTtlMs` | `300000`, between `0` and `300000`. |
| `maxTokenLifetimeSeconds` | `3600`, between `60` and `86400`. |

Returns `async verifyAccessToken(token, requiredScopes = [])`. Success returns
only the frozen `{ issuer, subject, scopes }` identity. Verification failures throw
`MerchantOAuthError` with `code: invalid_token`; an authenticated token missing a
required scope throws `code: insufficient_scope`. Error messages are fixed and
never include tokens, provider responses, or claims. `parseOAuthScopes` is also
exported for services that need the same space-delimited scope parser.

The supported access-token profile is intentionally specific:

- RS256 JWT, an explicit `kid`, and optional `typ` of `JWT` or `at+jwt`.
- Exact `iss`; `aud` contains the exact MCP resource; nonempty stable `sub`.
- Integer `iat` and `exp`, bounded token lifetime, no future issuance, and optional
  integer `nbf`. Expiry is checked again after signature verification. Clocks must
  be synchronized; no expiry grace period is granted.
- Space-delimited OAuth `scope`. Required scopes are checked after the signature.
- Public RSA signing keys of 2048–8192 bits. Ambiguous `kid` values, private key
  material, encryption keys, unsupported algorithms, and unsuitable key operations
  are rejected.
- Token-controlled `jku`, `x5u`, `jwk`, critical headers, and unencoded JWT bodies
  are rejected. Signing keys are never fetched from token input.

JWTs are limited to 16 KiB; JWKS responses to 64 KiB and 32 keys. Both
`application/json` and the registered `application/jwk-set+json` media type are
accepted. The JWKS request
has a five-second timeout. Concurrent refreshes are coalesced. Unknown keys fail
closed until the bounded cache expires; publish new keys at least one cache TTL
before using them, and retain old verification keys until their tokens expire.
Provider failures do not fall back to unsigned or shared-secret authentication.
This resource server does not perform token introspection; immediate revocation
needs an application policy check or a provider-specific verifier. Use short-lived
tokens and rotate refresh tokens at the established identity provider.

## Tools, scopes, and service contracts

All tools require `merchant_id` equal to the server binding. The exact merchant ID
is also advertised as a JSON Schema `const`. Tool input cannot supply a subject,
issuer, contact, Chatwoot account, inbox, site slug, or `claimed` flag. The service
receives only validated fields and the verified identity.

| MCP tool | Service method and arguments | Authorization |
| --- | --- | --- |
| `search_merchant_knowledge` | `searchKnowledge({ merchantId, query })` | Public `noauth`; approved public material only. |
| `start_support_conversation` | `startConversation({ principal, merchantId, message, idempotencyKey, consent })` | `merchant:support:write` |
| `send_support_message` | `sendMessage({ principal, merchantId, conversationId, message, idempotencyKey })` | `merchant:support:write` |
| `get_support_updates` | `getUpdates({ principal, merchantId, conversationId, cursor? })` | `merchant:support:read` |
| `request_human_support` | `requestHuman({ principal, merchantId, conversationId, idempotencyKey })` | `merchant:support:write` |

`principal` is exactly `{ issuer, subject, scopes }`, with no token or extra claims.
Queries are at most 500 characters; messages are at most 4000. Conversation IDs and
mutation idempotency keys are lowercase UUID v4. A cursor is a nonnegative decimal
message ID encoded as a string, without leading zeroes; it must fit a JavaScript
safe integer. Omit the cursor on the first read.

Starting a conversation also requires:

```json
{ "consent": { "accepted": true, "version": "merchant-support-v1" } }
```

The tool descriptions require the user's intent to contact the named merchant and
share the specified message with its AI and human support team. This consent field
records that decision; it is not a proof of merchant ownership or an OAuth grant.
Subsequent sends require the user's intent to send the exact new message. Never
forward the surrounding ChatGPT transcript. Human handoff is called only when the
user asks for a person.

The public knowledge tool and update reads are explicitly read-only with
`openWorldHint: false`. Sends and handoffs have `readOnlyHint: false`,
`destructiveHint: true`, and `openWorldHint: true`: a message already delivered to
another party cannot be recalled by this tool. Mutations advertise
`idempotentHint: true` because the support service must enforce persistent
idempotency, including payload conflict detection.

### Persistent support-service obligations

The MCP transport intentionally does not own customer conversations. The service
must persist an association of issuer, subject, merchant binding, and an opaque
conversation UUID. Every read, send, and handoff must verify that association and
the expected Chatwoot account, API inbox, and contact before accessing messages.
An MCP session ID, caller-supplied UUID, email address, or browser `claimed` state
does not authorize a conversation.

Persist idempotency claims atomically with the intended action. Retries with the
same key and payload must resolve to the original operation; conflicting payloads
must fail. A network timeout after a possible upstream write is an uncertain
delivery, not a safe instruction to send the message again. The service owns
outbox recovery, upstream reconciliation, rate limits, and concurrency handling.

Return JSON objects containing only customer-visible projections. Never return
provider credentials, private staff notes, arbitrary raw Chatwoot payloads,
internal authorization hashes, or another customer's messages. Successful service
objects are returned unchanged in both MCP `structuredContent` and text JSON.
The transport does not synthesize delivery or reply states.

Use the actual operation status: `pending`, `delivered`, `uncertain`, or `failed`.
A successful MCP invocation is only a successful tool invocation. It is not proof
that a message was delivered or a human joined the conversation. Updates should
contain actual permitted messages and a cursor; an empty list is a valid result.
Polling is the current channel's mechanism for receiving asynchronous replies.

Known service errors receive fixed public messages. `NOT_FOUND`,
`CONVERSATION_NOT_FOUND`, `CONVERSATION_BINDING_MISMATCH`, and `FORBIDDEN` all hide conversation details.
`IDEMPOTENCY_CONFLICT`, `CONSENT_REQUIRED`, `RATE_LIMITED`,
`SUPPORT_NOT_CONFIGURED`, and `SERVICE_UNAVAILABLE` retain their error code.
Unknown failures are reduced to `SERVICE_UNAVAILABLE` without leaking upstream
messages. The service remains responsible for private diagnostic logs.
`DELIVERY_REVIEW_REQUIRED` explicitly forbids resending with a new request ID;
`RECEIPT_UNAVAILABLE` preserves the original request ID for retry.
`CONVERSATION_NOT_READY` and `CONVERSATION_BUSY` tell the caller to check updates.
`SUPPORT_NOT_CONNECTED` and `KNOWLEDGE_UNAVAILABLE` distinguish missing capabilities.

## MCP and OAuth behavior

The endpoint implements the stateless JSON-response form of Streamable HTTP.
It does not advertise SSE subscriptions, resumable MCP sessions, Tasks, or Events.
The current explicit protocol version is `2025-11-25`; compatible `2025-06-18`
negotiation is also accepted. Other protocol offers negotiate the implemented
version. Initialization without an HTTP version header is accepted.
An unsupported `MCP-Protocol-Version` HTTP header is rejected.

- `POST` requires `Content-Type: application/json` and both `application/json`
  and `text/event-stream` in `Accept`. JSON-RPC batches and malformed frames are
  rejected; body size is bounded at 24 KiB before tool execution.
- `initialize`, `ping`, `tools/list`, and `tools/call` have JSON-RPC responses.
- `notifications/initialized` and `notifications/cancelled` receive `202` with
  no response body and cannot execute tools. This stateless implementation does
  not interrupt an already accepted business operation on a cancellation notice.
- `GET` and `DELETE` on the MCP endpoint return `405 Allow: POST`. No fictitious
  stream or MCP session is created.
- Every request with an `Origin` must match an explicit allowed origin. The
  incoming URL origin must match the canonical resource origin. Behind a proxy,
  construct the external URL from trusted deployment configuration; do not trust
  arbitrary forwarded-host headers.
- Resource metadata is available at
  `/.well-known/oauth-protected-resource{resource-path}` and the root well-known
  path. It advertises the exact resource, configured issuer, the two support
  scopes, and bearer tokens in the authorization header only.
- Private calls without a token or with insufficient verified scope return a
  tool error containing `_meta["mcp/www_authenticate"]`, including `error`,
  `error_description`, and the resource metadata URL. This is the tool-level
  signal used by ChatGPT's linking UI. The same challenge is in the response
  header. Invalid supplied tokens receive HTTP `401` and `WWW-Authenticate`.
- Without an OAuth issuer/verifier, private tools fail closed and resource
  metadata returns `503`. Public knowledge remains callable. A shared API token
  or fabricated identity is never a substitute.

## Identity-provider and rollout requirements

Configure an established authorization server for the authorization-code flow
with PKCE S256 and exact redirect validation. Publish its authorization metadata,
support ChatGPT client registration/identification, accept the exact MCP `resource`
parameter, and mint access tokens with that audience and the intended scopes.
Configure the actual redirect URI shown by the ChatGPT integration flow; do not
derive a callback from an arbitrary browser URL. The identity provider owns login,
consent, refresh, revocation, and OAuth client management. Customer account linking
is separate from verified merchant claiming and inbox binding.

Local tests are not evidence that ChatGPT is connected to a live merchant. Before
reporting a live connection, deploy the handler and persistence behind the final
HTTPS URL, configure the real IdP and merchant inbox, connect the MCP server from
ChatGPT, finish real account linking, send an explicitly authorized test message,
and observe its real Chatwoot receipt and permitted reply through
`get_support_updates`. Also exercise a different customer, a different merchant,
expired credentials, and a repeated idempotency key. Directory listing/public
distribution is a separate OpenAI submission and review step.

The tests in this branch generate local RSA key pairs and use bounded test service
fixtures. They verify cryptographic authorization, transport behavior, tenant
binding, intent fields, status preservation, and error redaction. They do not call
a real Chatwoot server, send messages to customers, or complete a real OAuth login.

```sh
node --test runtime/merchant-oauth.test.mjs runtime/merchant-mcp.test.mjs
```

## Official protocol references

Reviewed on 2026-11-24:

- [OpenAI MCP server concepts](https://developers.openai.com/plugins/concepts/mcp-server)
- [OpenAI authentication and tool-level linking](https://developers.openai.com/plugins/build/auth)
- [OpenAI tool planning and annotations](https://developers.openai.com/plugins/plan/tools)
- [OpenAI MCP server implementation](https://developers.openai.com/plugins/build/mcp-server)
- [Connecting a server in ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt)
- [MCP 2025-11-25 Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP 2025-11-25 authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [RFC 7517 JWK Set media type](https://www.rfc-editor.org/rfc/rfc7517.html#section-8.5)

Documentation and a reachable endpoint alone do not establish that a user has
linked an account or that a merchant support message has been delivered.
