-- Generated from runtime/merchant-*.schema.sql by pnpm merchant:migration.
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS merchant_knowledge_versions_no_update
BEFORE UPDATE ON merchant_knowledge_versions
BEGIN
  SELECT RAISE(ABORT, 'Immutable merchant knowledge version');
END;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS merchant_claim_states (
  site_slug TEXT NOT NULL,
  merchant_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  state_sha256 TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (site_slug, merchant_id)
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS merchant_claim_evidence_no_update
BEFORE UPDATE ON merchant_claim_evidence
BEGIN
  SELECT RAISE(ABORT, 'Immutable merchant claim evidence');
END;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS merchant_support_principal ON merchant_support_threads(site_slug, merchant_id, principal_hash, created_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS merchant_support_remote_conversation ON merchant_support_threads(site_slug, merchant_id, binding_hash, conversation_id) WHERE conversation_id IS NOT NULL;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS merchant_support_operation_state ON merchant_support_operations(site_slug, merchant_id, state, updated_at);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS merchant_support_thread_writer ON merchant_support_operations(site_slug, merchant_id, thread_id) WHERE state IN ('running','uncertain');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS merchant_support_limits (
  site_slug TEXT NOT NULL, merchant_id TEXT NOT NULL, principal_hash TEXT NOT NULL,
  action TEXT NOT NULL, window INTEGER NOT NULL, count INTEGER NOT NULL,
  PRIMARY KEY (site_slug, merchant_id, principal_hash, action, window)
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS merchant_agentbot_ready_idx ON merchant_agentbot_jobs (site_slug, merchant_id, chatwoot_origin, account_id, inbox_id, status, next_attempt_at, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS merchant_agentbot_conversation_idx ON merchant_agentbot_jobs (site_slug, merchant_id, chatwoot_origin, account_id, inbox_id, conversation_id, status, lease_until);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS merchant_support_reconciliation_history ON merchant_support_reconciliations(site_slug, merchant_id, recorded_at);
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS merchant_support_reconciliation_no_update
BEFORE UPDATE ON merchant_support_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'Merchant reconciliation audit records are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS merchant_support_reconciliation_no_delete
BEFORE DELETE ON merchant_support_reconciliations
BEGIN
  SELECT RAISE(ABORT, 'Merchant reconciliation audit records are immutable');
END;
