# Supplier quote capture contract (PR #17)

This slice defines a strict supplier quote receipt and its D1 append-only storage table.

- A quote must reference one RFQ draft, exact RFQ snapshot hash, tenant and supplier.
- Supplier identity is a previously resolved internal supplier ID; this module does not discover or verify suppliers.
- Monetary values use integer minor units and ISO 4217 currency codes; no floating-point money.
- MOQ, lead time, Incoterm, named place, validity and payment terms are explicit.
- Each submission is immutable and SHA-256 bound. Corrections must be new submissions, never edits.
- No quote ranking, buyer disclosure, supplier outreach, purchase order or acceptance is performed here.

The migration is an additive D1 schema file. Register it with the existing migration journal before applying it to a real database. The table's unique constraint prevents exact duplicate payload receipts for the same supplier/RFQ; request-level idempotency still belongs in the authenticated intake service.
