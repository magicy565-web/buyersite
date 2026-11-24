-- Apply in a versioned deployment migration, never inside a webhook/request handler.
CREATE TABLE IF NOT EXISTS merchant_agentbot_jobs (
  id TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL,
  site_slug TEXT NOT NULL,
  chatwoot_origin TEXT NOT NULL,
  account_id INTEGER NOT NULL,
  inbox_id INTEGER NOT NULL,
  conversation_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivery_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','sending','delivered','handed_off','ignored','unknown','dead')),
  action TEXT NOT NULL DEFAULT 'answer' CHECK (action IN ('answer','handoff')),
  answer_json TEXT,
  knowledge_revision TEXT,
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  sent_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (site_slug, merchant_id, chatwoot_origin, account_id, inbox_id, message_id)
);
CREATE INDEX IF NOT EXISTS merchant_agentbot_ready_idx ON merchant_agentbot_jobs (site_slug, merchant_id, chatwoot_origin, account_id, inbox_id, status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS merchant_agentbot_conversation_idx ON merchant_agentbot_jobs (site_slug, merchant_id, chatwoot_origin, account_id, inbox_id, conversation_id, status, lease_until);
