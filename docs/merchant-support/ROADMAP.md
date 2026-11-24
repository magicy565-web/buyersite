# BuyerSite merchant support: integrated delivery plan

Date: 2026-11-24. This plan extends `feat/chatwoot-merchant-agent` (PR #19).
It tracks implementation separately from a live provider connection and official business approval.

## Product outcome

A buyer can open merchant support on BuyerSite, or connect a customer account to the
BuyerSite ChatGPT Plugin and send an explicitly chosen message to that merchant.
Chatwoot owns the support inbox and human handoff. An external answer provider may
answer from a versioned, approved merchant knowledge bundle. A separate Business Hub
pack helps an authorized owner claim and configure the native ChatGPT business presence.

Native Business Hub recognition and the OAuth/MCP Plugin are separate integrations.
No endpoint in this project registers Chatwoot as a native Business Agent, approves a
claim, performs Persona verification, or guarantees ChatGPT search distribution.

## Parallel branch map

| Branch | Ownership | Implemented deliverable | Integration contract |
| --- | --- | --- | --- |
| `feat/chatwoot-merchant-agent` | Existing PR #19 | Click-loaded website widget; merchant disclosure; private-edition exclusion | Website Inbox and public widget token |
| `feat/chatwoot-agent-runtime` | Chatwoot transport and automation | Bound API client; signed webhook; durable queue; provider adapter; human control | `merchant-chatwoot.mjs`, `merchant-agentbot.mjs`, `merchant-answer-provider.mjs` |
| `feat/merchant-knowledge-claims` | Merchant facts and owner workflow | Immutable knowledge versions; expiry; source search; claim evidence; pack; owner CLI | `merchant-knowledge.mjs`, `merchant-onboarding.mjs` |
| `feat/chatgpt-merchant-channel` | ChatGPT channel | Streamable HTTP MCP; five tools; protected-resource metadata; JWT/JWKS verification | `merchant-mcp.mjs`, `merchant-oauth.mjs` |
| `integration/merchant-support` | Cross-system delivery | Worker routes; conversation ownership; receipts; reconciliation; unified migrations; integration tests and runbook | The complete runnable integration tree |

Published module reviews: [Chatwoot runtime PR #20](https://github.com/magicy565-web/buyersite/pull/20),
[knowledge and claim PR #21](https://github.com/magicy565-web/buyersite/pull/21), and
[ChatGPT channel PR #22](https://github.com/magicy565-web/buyersite/pull/22).

All three feature branches start from the same PR #19 commit. Integration uses actual
merge commits so their history remains inspectable. Feature reviews compare against
PR #19; the integration review is the combined delivery. Merge the combined delivery
once after its gates pass; do not deploy the independent module branches.

The older marketing and supplier work is not blindly merged. This integration reuses
the already reviewed migration sequence through `0004`, registers the existing sourcing
session schema as `0005`, and adopts the existing marketing tenant/lease fixes and tests.
Merchant tables are isolated in `0006_merchant_support.sql`.

## Iterations and acceptance

| Iteration | Scope | Code deliverable | Completion gate |
| --- | --- | --- | --- |
| 0: shared contracts | Merchant identity, two inboxes, scopes, migrations | Server binding and unified schema | Cross-tenant/origin/account/instance tests pass; invalid binding disables service |
| 1: website support | Existing widget plus common merchant binding | PR #19 and binding adapter | No SDK before user click; only authorized public edition exposes configuration |
| 2: safe answer pipeline | Signed incoming webhook, queue, provider, handoff | Chatwoot runtime branch | Bad signature rejected; intake durable before 202; no duplicate reply after timeout; human takeover suppresses automation |
| 3: merchant knowledge | Approval, immutable versions, activate CAS, expiry | Knowledge branch | No cross-merchant/internal facts; stale activation rejected; commercial facts expire |
| 4: ChatGPT direct conversation | OAuth scopes, five MCP tools, private conversation ownership | ChatGPT branch and support service | OAuth-to-Chatwoot contract flow passes; other buyers cannot poll; private notes excluded; delivery uncertainty visible |
| 5: native claim preparation | Business Hub pack, owner evidence and review state | Knowledge branch and CLI | Pack uses the server's active facts; fake platform verification rejected; official submission remains an owner action |
| 6: integrated operations | Owner routes, diagnostics, reconciliation, migrations, private build | Integration branch | All runtime/knowledge/builder/CLI suites; type check; private build; browser regression; branch/PR artifacts |
| 7: merchant staging | Real merchant authorization, Chatwoot test inboxes, IdP and answer endpoint | Configuration of the implemented interfaces | Signed real webhook, acknowledged message, real reply, token expiry, disconnect and human handoff tested with consenting test accounts |
| 8: launch | Official claim and Persona flow, Plugin installation/review, exact-source publication review | Owner/platform approvals and deployment configuration | Approved claim where eligible; actual Plugin connection; operational queue schedule; rollback drill; public release evidence for the exact commit |

Iterations 0–6 are developed together in this delivery. Iterations 7–8 require external
merchant/provider/platform configuration and observed results. Passing mock provider
tests does not complete those gates.

Current integration evidence: 289 automated tests pass, type checking and the private
build pass, and all 13 generated HTML files pass static output checks. Local browser
acceptance is blocked before page launch by the execution environment's socket
permissions; it is not marked passed. The existing CI browser gate remains required.
See [verification record](../verification/2026-11-24-merchant-integration.json).

## Business states visible to operators

- **Not configured:** no credentials or merchant authorization; no invented response.
- **Configured:** settings pass validation; this does not assert that a provider is reachable.
- **Pending:** a durable job or operation exists; delivery is not yet confirmed.
- **Delivered:** the scoped upstream acknowledgement was validated.
- **Uncertain:** a write may have reached Chatwoot; a new automatic send is blocked.
- **Human requested:** local automation is stopped; remote queue confirmation is reported separately.
- **Owner recorded claim evidence:** an owner attached a reference and hash. `platform_verified` stays `false`.

## Test strategy

Use real SQLite for persistence, CAS, constraints, tenant separation, expired leases and
restarts. Use explicitly fake HTTP Chatwoot/answer servers and locally generated JWTs
for provider/protocol contracts. No test requires live customer messages or model calls.
Browser checks use the private build, which keeps merchant SDKs and publication disabled.
Real vendor interoperability is a separate staging acceptance with test-only accounts.

## First live merchant checklist

1. Record genuine authority to represent the merchant. Configure canonical origin,
   privacy page and authorization reference. Approve real public evidence.
2. Create a Website Inbox and a separate API Inbox under the intended Chatwoot account.
   Use a supported Chatwoot release with signed AgentBot webhook delivery.
3. Configure distinct service-user and AgentBot credentials, signed webhook secret and
   bot ID. Test using consented synthetic customer accounts.
4. Configure the identity provider for OAuth 2.1, PKCE S256, the exact MCP resource
   audience and the two support scopes. Store credentials only in server secrets.
5. Implement/configure the explicit answer-provider contract or keep automatic answers
   disabled and observe successful human handoff. An OpenMausBot installation needs a
   compatible shim; its native task API is not assumed to implement this HTTP contract.
6. Configure a scheduled queue drain. Demonstrate timeout recovery, evidence freshness,
   reconciliation, retention and the operator alert route.
7. Install the MCP endpoint in an eligible ChatGPT development/workspace environment.
   Complete any applicable review before broader distribution.
8. Prepare the native claim pack, then perform the official claim and Persona flow with
   the authorized person. Record observed evidence, preview and publication separately.
9. Review the exact public source and media, complete release evidence, then change
   publication mode and deploy the approved integration commit.

## Rollback

Turn `BUYERSITE_MERCHANT_SUPPORT_ENABLED` off to close public merchant routes and the
unified widget. Remove the answer-provider credentials to retain human support without
automatic answers. Disable the Chatwoot AgentBot association if external webhook delivery
must stop. Keep additive migrations and receipts; never roll back by dropping customer
state or replaying uncertain writes. Native Business Hub and ChatGPT Plugin visibility
must be managed in their own platform controls.

## Sources and related contracts

- [Official Business Hub setup](https://help.openai.com/en/articles/20001635-setting-up-your-business-on-chatgpt)
- [Official Plugin authentication](https://developers.openai.com/plugins/build/auth)
- [Chatwoot AgentBots](https://www.chatwoot.com/hc/user-guide/articles/1677497472-how-to-use-agent-bots)
- [Deployment runbook](./RUNBOOK.md)
- [Knowledge and claim contract](./KNOWLEDGE-AND-CLAIM.md)
- [Owner CLI](./OWNER-CLI.md)
- [ChatGPT channel](../CHATGPT-MERCHANT-CHANNEL.md)
- [Chatwoot runtime](../../runtime/merchant-chatwoot.md)
- [Answer provider contract](../../runtime/merchant-answer-provider.md)
