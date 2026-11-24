-- Append-only owner recovery evidence. No customer message bodies or OAuth tokens.
CREATE TABLE IF NOT EXISTS merchant_support_reconciliations (
  site_slug TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (operation_kind IN ('start','message','human')),
  previous_updated_at INTEGER NOT NULL,
  resolution TEXT NOT NULL CHECK (resolution IN ('delivered','not_delivered')),
  verification TEXT NOT NULL CHECK (verification IN ('provider_verified','owner_recorded')),
  actor_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  external_conversation_id INTEGER,
  external_message_id INTEGER,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (site_slug, merchant_id, id),
  UNIQUE (site_slug, merchant_id, operation_id),
  CHECK ((resolution = 'delivered' AND verification = 'provider_verified') OR
    (resolution = 'not_delivered' AND verification = 'owner_recorded'))
);
CREATE INDEX IF NOT EXISTS merchant_support_reconciliation_history ON merchant_support_reconciliations(site_slug, merchant_id, recorded_at);
CREATE TRIGGER IF NOT EXISTS merchant_support_reconciliation_no_update
BEFORE UPDATE ON merchant_support_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'Merchant reconciliation audit records are immutable');
END;
CREATE TRIGGER IF NOT EXISTS merchant_support_reconciliation_no_delete
BEFORE DELETE ON merchant_support_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'Merchant reconciliation audit records are immutable');
END;
