import { assertSourcingSession } from "./session-contract.mjs";

const fail = (message) => { throw new TypeError(`SOURCING_STORE: ${message}`); };

function parseRow(row) {
  if (!row) return null;
  let session;
  try { session = JSON.parse(row.session_json); }
  catch { fail("stored session JSON is invalid"); }
  assertSourcingSession(session);
  if (session.id !== row.session_id || session.tenantId !== row.tenant_id ||
      session.revision !== row.revision || session.status !== row.status) {
    fail("stored session index does not match its immutable payload");
  }
  return session;
}

function assertDb(db) {
  if (!db || typeof db.prepare !== "function") fail("a Cloudflare D1 binding is required");
}

export async function createSourcingSessionRecord(db, session) {
  assertDb(db);
  assertSourcingSession(session);
  const result = await db.prepare(`
    INSERT INTO sourcing_sessions (
      tenant_id, session_id, buyer_id, issue_id, issue_revision, article_path,
      status, revision, session_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    session.tenantId, session.id, session.buyerId, session.source.issueId,
    session.source.issueRevision, session.source.articlePath, session.status,
    session.revision, JSON.stringify(session), session.createdAt, session.updatedAt,
  ).run();
  if (result?.success === false) fail("D1 rejected session creation");
  return session;
}

export async function getSourcingSessionRecord(db, { tenantId, sessionId }) {
  assertDb(db);
  if (typeof tenantId !== "string" || !tenantId || typeof sessionId !== "string" || !sessionId) fail("tenant and session ids are required");
  const row = await db.prepare(`
    SELECT tenant_id, session_id, status, revision, session_json
    FROM sourcing_sessions
    WHERE tenant_id = ? AND session_id = ?
    LIMIT 1
  `).bind(tenantId, sessionId).first();
  return parseRow(row);
}

export async function saveSourcingSessionRecord(db, session, { expectedRevision }) {
  assertDb(db);
  assertSourcingSession(session);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
      session.revision !== expectedRevision + 1) fail("invalid expected revision");
  const result = await db.prepare(`
    UPDATE sourcing_sessions
    SET buyer_id = ?, issue_id = ?, issue_revision = ?, article_path = ?,
        status = ?, revision = ?, session_json = ?, updated_at = ?
    WHERE tenant_id = ? AND session_id = ? AND revision = ?
  `).bind(
    session.buyerId, session.source.issueId, session.source.issueRevision,
    session.source.articlePath, session.status, session.revision,
    JSON.stringify(session), session.updatedAt, session.tenantId, session.id,
    expectedRevision,
  ).run();
  if (result?.success === false) fail("D1 rejected session update");
  const changed = result?.meta?.changes ?? result?.changes;
  if (changed === 0) return { saved: false, reason: "revision-conflict-or-not-found" };
  if (changed !== 1) fail("unexpected number of updated session records");
  return { saved: true, session };
}

export async function deleteSourcingSessionRecord(db, { tenantId, sessionId, expectedRevision }) {
  assertDb(db);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) fail("expected revision is required");
  const result = await db.prepare(`
    DELETE FROM sourcing_sessions
    WHERE tenant_id = ? AND session_id = ? AND revision = ?
  `).bind(tenantId, sessionId, expectedRevision).run();
  if (result?.success === false) fail("D1 rejected session deletion");
  const changed = result?.meta?.changes ?? result?.changes;
  return { deleted: changed === 1, reason: changed === 1 ? null : "revision-conflict-or-not-found" };
}
