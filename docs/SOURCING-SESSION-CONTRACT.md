# Buyer Sourcing Session Contract (PR #13)

This module is the first durable domain boundary for ZeroForm. It is intentionally transport- and model-neutral: a chat model may propose facts, but it cannot confirm buyer intent or create an RFQ.

## Contract

- Every session is pinned to one tenant, one BuyerSite issue revision and one canonical article path from that issue.
- Requirements have explicit provenance: `buyer-stated`, `buyer-confirmed`, or `source-derived`. A model confidence score is never a provenance type.
- Required fields for an RFQ are product, quantity and destination market. Other fields remain optional follow-ups and must not block an initial qualified enquiry.
- Partial answers are accepted. The server returns only the remaining required fields.
- Every mutation uses optimistic concurrency via `expectedRevision`; stale writes fail rather than overwrite a newer conversation.
- A buyer must explicitly confirm the complete brief before an RFQ handoff. Model output cannot move a session to confirmed.
- The contract contains no supplier dispatch, price calculation, quote issuance or outbound messaging.

## API surface

`createSourcingSession`, `applyRequirementPatch`, `getMissingRequiredFields`, `getOptionalFollowUps`, `confirmSourcingSession`, `markSourcingSessionHandedOff`, `assertSourcingSession`.

## Verification

```sh
node --test src/sourcing/session-contract.test.mjs
```

The module is deterministic and uses Node built-ins only. Persistence, HTTP routes, OpenMausBot execution, real model extraction and RFQ creation are subsequent PRs, not claimed here.
