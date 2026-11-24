-- Included by the unified merchant-support migration. Apply with that migration,
-- not as an independent production migration.
CREATE TABLE IF NOT EXISTS merchant_knowledge_versions (
  site_slug TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  bundle_json TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  PRIMARY KEY (site_slug, merchant_id, revision)
);
CREATE TABLE IF NOT EXISTS merchant_knowledge_heads (
  site_slug TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  activated_by TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  PRIMARY KEY (site_slug, merchant_id),
  FOREIGN KEY (site_slug, merchant_id, revision)
    REFERENCES merchant_knowledge_versions (site_slug, merchant_id, revision)
);
CREATE TRIGGER IF NOT EXISTS merchant_knowledge_versions_no_update
BEFORE UPDATE ON merchant_knowledge_versions
BEGIN
  SELECT RAISE(ABORT, 'Immutable merchant knowledge version');
END;

CREATE TABLE IF NOT EXISTS merchant_claim_states (
  site_slug TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  state_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_slug, merchant_id)
);
CREATE TABLE IF NOT EXISTS merchant_claim_evidence (
  site_slug TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  receipt_sha256 TEXT NOT NULL,
  applied_revision INTEGER NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (site_slug, merchant_id, event_id),
  UNIQUE (site_slug, merchant_id, applied_revision),
  FOREIGN KEY (site_slug, merchant_id)
    REFERENCES merchant_claim_states (site_slug, merchant_id)
);
CREATE TRIGGER IF NOT EXISTS merchant_claim_evidence_no_update
BEFORE UPDATE ON merchant_claim_evidence
BEGIN
  SELECT RAISE(ABORT, 'Immutable merchant claim evidence');
END;
