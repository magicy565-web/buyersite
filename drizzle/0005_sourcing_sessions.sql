CREATE TABLE IF NOT EXISTS sourcing_sessions (
  tenant_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  buyer_id TEXT,
  issue_id TEXT NOT NULL,
  issue_revision TEXT,
  article_path TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('collecting', 'ready_for_confirmation', 'confirmed', 'handed_off', 'closed')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  session_json TEXT NOT NULL CHECK (json_valid(session_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, session_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sourcing_sessions_tenant_status_updated
  ON sourcing_sessions (tenant_id, status, updated_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sourcing_sessions_buyer_updated
  ON sourcing_sessions (tenant_id, buyer_id, updated_at DESC);
