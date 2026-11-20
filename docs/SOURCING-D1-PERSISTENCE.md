# D1 persistence for ZeroForm sessions (PR #14)

This migration and repository adapter persist the PR #13 source-bound session contract in Cloudflare D1.

## Guarantees
- Composite primary key `(tenant_id, session_id)`; reads and writes always require tenant scope.
- Session JSON is stored with queryable status, revision, source issue and article columns. The adapter checks those columns against the payload when reading.
- Updates use compare-and-swap on the expected revision. Concurrent stale updates return `revision-conflict-or-not-found`; they never overwrite newer buyer answers.
- Session JSON is validated against the domain contract before every write and after every read.
- The adapter does not create a buyer identity, infer missing requirements, confirm buyer intent, create RFQs, or send messages.

## Integration
Apply `migrations/202611200001_sourcing_sessions.sql` to the existing D1 database using the repository's configured Wrangler environment. Bind that existing D1 binding as `DB` (or pass the binding explicitly to these functions). Do not create a second database or silently fall back to local memory.

Call `createSourcingSessionRecord(DB, session)` for a new session; `getSourcingSessionRecord(DB, { tenantId, sessionId })` for a tenant-scoped read; and `saveSourcingSessionRecord(DB, nextSession, { expectedRevision })` for a compare-and-swap update. A zero-row update is a conflict/not-found and must be reconciled by re-reading the same tenant-scoped session.

Before production integration, wire the migration into the existing Wrangler D1 migration configuration and add authenticated API routes that derive tenant identity from the server session—not request JSON or client headers. This PR intentionally does not invent that auth boundary because the exact production binding/config was not available for verification.
