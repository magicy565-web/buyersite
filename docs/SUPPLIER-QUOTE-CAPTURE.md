# Supplier quote capture contract (PR #17)

This slice defines a strict supplier quote receipt and its D1 append-only storage table.

- A quote must reference one RFQ draft, exact RFQ snapshot hash, tenant and supplier.
- Supplier identity is a previously resolved internal supplier ID; this module does not discover or verify suppliers.
- Monetary values use integer minor units and ISO 4217 currency codes; no floating-point money.
- MOQ, lead time, Incoterm, named place, validity and payment terms are explicit.
- Each submission is immutable and SHA-256 bound. Corrections must be new submissions, never edits.
- No quote ranking, buyer disclosure, supplier outreach, purchase order or acceptance is performed here.

The supplier table is the additive **`drizzle/0004_supplier_quote_submissions.sql`** migration. The shared Drizzle journal registers marketing outbox at `0003` and supplier quotes at `0004`; both branches carry byte-identical SQL and journal files. The old unregistered `0003_supplier_quote_submissions.sql` has been removed. The table's unique constraint prevents duplicate payload receipts for the same supplier/RFQ; request-level idempotency remains the responsibility of authenticated intake.

Before a remote D1 upgrade, inspect the database's migration ledger and schema. If a supplier migration was manually recorded as `0003`, stop and reconcile it instead of rewriting history. The isolated migration regression suite in `runtime/d1-migrations.test.mjs` verifies upgrading from `0002`, from marketing-only `0003`, repeat application, and preservation of existing enquiries, events, outbox and quote rows. No production D1 migration has been applied.
