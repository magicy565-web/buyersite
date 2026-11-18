CREATE TABLE buyer_enquiries (
  id TEXT PRIMARY KEY NOT NULL,
  site_slug TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('new', 'qualified', 'archived')),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  material TEXT NOT NULL,
  quantity TEXT NOT NULL,
  application TEXT NOT NULL,
  delivery TEXT NOT NULL,
  page_path TEXT NOT NULL,
  attribution_json TEXT NOT NULL,
  consent_version TEXT NOT NULL,
  consent_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX buyer_enquiries_idempotency ON buyer_enquiries (site_slug, idempotency_key_hash);
--> statement-breakpoint
CREATE INDEX buyer_enquiries_inbox ON buyer_enquiries (site_slug, created_at, id);
--> statement-breakpoint
CREATE TABLE buyer_rate_limits (
  site_slug TEXT NOT NULL,
  scope TEXT NOT NULL,
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (site_slug, scope, bucket, window_start)
);
--> statement-breakpoint
CREATE INDEX buyer_rate_limits_expiry ON buyer_rate_limits (expires_at);
--> statement-breakpoint
CREATE TABLE buyer_assistant_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  site_slug TEXT NOT NULL,
  upstream_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX buyer_assistant_sessions_expiry ON buyer_assistant_sessions (expires_at);
