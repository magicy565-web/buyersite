CREATE TABLE IF NOT EXISTS supplier_quote_submissions (
  tenant_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  rfq_id TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  rfq_snapshot_hash TEXT NOT NULL,
  snapshot_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status = 'received'),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  submitted_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, submission_id),
  UNIQUE (tenant_id, rfq_id, supplier_id, snapshot_hash)
);

CREATE INDEX IF NOT EXISTS idx_supplier_quote_submissions_rfq
  ON supplier_quote_submissions (tenant_id, rfq_id, submitted_at DESC);

CREATE INDEX IF NOT EXISTS idx_supplier_quote_submissions_supplier
  ON supplier_quote_submissions (tenant_id, supplier_id, submitted_at DESC);
