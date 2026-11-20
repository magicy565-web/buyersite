# Source-bound RFQ draft contract (PR #16)

The RFQ draft is a deterministic, immutable snapshot of a buyer-confirmed ZeroForm session.

- It can only be created from a session in `confirmed` state.
- Required fields are product, positive quantity and destination market.
- Each included requirement must be buyer-confirmed or source-derived; model output is not accepted as provenance.
- The snapshot carries tenant, issue revision, canonical article path, session ID and session revision.
- SHA-256 binds the exact serialized snapshot. Any later edit invalidates the hash.
- Creation does not select suppliers, send messages, issue a supplier RFQ, generate prices or accept an order. Those are separate authorized operations.

Run `node --test src/sourcing/session-contract.test.mjs src/sourcing/rfq-contract.test.mjs` in the repository's Node 24 checkout.
