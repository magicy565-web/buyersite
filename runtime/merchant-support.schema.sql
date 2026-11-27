-- Private OAuth identities are stored as hashes. Message bodies stay in Chatwoot.
CREATE TABLE IF NOT EXISTS merchant_support_threads (
  site_slug TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  principal_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  contact_id INTEGER,
  contact_source_id TEXT,
  conversation_id INTEGER,
  state TEXT NOT NULL CHECK (state IN ('creating','active','uncertain','failed')),
  handoff_requested INTEGER NOT NULL DEFAULT 0 CHECK (handoff_requested IN (0,1)),
  consent_version TEXT NOT NULL,
  consent_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (site_slug, merchant_id, id)
);
CREATE INDEX IF NOT EXISTS merchant_support_principal ON merchant_support_threads(site_slug, merchant_id, principal_hash, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS merchant_support_remote_conversation ON merchant_support_threads(site_slug, merchant_id, binding_hash, conversation_id) WHERE conversation_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS merchant_support_operations (
  site_slug TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  principal_hash TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('start','message','human')),
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('running','delivered','uncertain','failed')),
  lease_token TEXT,
  lease_until INTEGER NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (site_slug, merchant_id, id),
  UNIQUE (site_slug, merchant_id, principal_hash, key_hash)
);
CREATE INDEX IF NOT EXISTS merchant_support_operation_state ON merchant_support_operations(site_slug, merchant_id, state, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS merchant_support_thread_writer ON merchant_support_operations(site_slug, merchant_id, thread_id) WHERE state IN ('running','uncertain');
CREATE TABLE IF NOT EXISTS merchant_support_limits (
  site_slug TEXT NOT NULL, merchant_id TEXT NOT NULL, principal_hash TEXT NOT NULL,
  action TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (site_slug, merchant_id, principal_hash, action, window)
);
