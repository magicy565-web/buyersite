CREATE TABLE buyer_marketing_outbox (
  id TEXT PRIMARY KEY NOT NULL,
  site_slug TEXT NOT NULL,
  event_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'delivered', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_until INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delivered_at TEXT,
  last_http_status INTEGER,
  last_error TEXT,
  UNIQUE (site_slug, event_id)
);
--> statement-breakpoint
CREATE INDEX buyer_marketing_outbox_due ON buyer_marketing_outbox (status, next_attempt_at, lease_until, created_at);
--> statement-breakpoint
CREATE INDEX buyer_marketing_outbox_campaign ON buyer_marketing_outbox (site_slug, campaign_id, status, created_at);
