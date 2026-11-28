import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { KnowledgeError, entityKey, requireText, stableId, validateAsset } from './contracts.mjs';

const decode = (row) => (row ? JSON.parse(row.data) : null);
const sameValue = (left, right) =>
  left.trim().replace(/\s+/g, ' ') === right.trim().replace(/\s+/g, ' ');

// The host, not a request payload, supplies the authenticated enterprise and actor.
export function openKnowledgeStore({ path, enterpriseId, actorId }) {
  requireText(enterpriseId, 'enterpriseId', 200);
  requireText(actorId, 'actorId', 200);
  requireText(path, 'database path', 4096);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS ki_sources (
      tenant TEXT NOT NULL, id TEXT NOT NULL, revision TEXT NOT NULL,
      digest TEXT NOT NULL, active INTEGER NOT NULL, data TEXT NOT NULL, bytes BLOB NOT NULL,
      PRIMARY KEY (tenant,id,revision)
    );
    CREATE TABLE IF NOT EXISTS ki_links (
      tenant TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
      entity_key TEXT NOT NULL, entity TEXT NOT NULL,
      PRIMARY KEY (tenant,source_id,revision,entity_key)
    );
    CREATE TABLE IF NOT EXISTS ki_parses (
      tenant TEXT NOT NULL, id TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
      created_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tenant,id)
    );
    CREATE TABLE IF NOT EXISTS ki_facts (
      tenant TEXT NOT NULL, id TEXT NOT NULL, entity_key TEXT NOT NULL,
      field TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (tenant,id)
    );
    CREATE TABLE IF NOT EXISTS ki_analyses (
      tenant TEXT NOT NULL, source_id TEXT NOT NULL, revision TEXT NOT NULL,
      entity_key TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (tenant,source_id,revision,entity_key)
    );
    CREATE TABLE IF NOT EXISTS ki_corrections (
      tenant TEXT NOT NULL, id TEXT NOT NULL, entity_key TEXT NOT NULL,
      created_at TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (tenant,id)
    );
    CREATE TABLE IF NOT EXISTS ki_deferrals (
      tenant TEXT NOT NULL, entity_key TEXT NOT NULL, field TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (tenant,entity_key,field)
    );
    CREATE TABLE IF NOT EXISTS ki_supplements (
      tenant TEXT NOT NULL, entity_key TEXT NOT NULL, source_id TEXT NOT NULL,
      revision TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (tenant,entity_key,source_id,revision)
    );
    CREATE TABLE IF NOT EXISTS ki_events (
      tenant TEXT NOT NULL, id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY (tenant,id)
    );
    CREATE INDEX IF NOT EXISTS ki_facts_entity ON ki_facts(tenant,entity_key);
    CREATE INDEX IF NOT EXISTS ki_parses_source ON ki_parses(tenant,source_id,revision);
  `);
  let inTransaction = false;
  function transaction(fn) {
    if (inTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    try {
      const value = fn();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      inTransaction = false;
    }
  }
  function event(action, details) {
    const data = {
      id: randomUUID(),
      action,
      actor_id: actorId,
      occurred_at: new Date().toISOString(),
      ...details,
    };
    db.prepare('INSERT INTO ki_events VALUES (?,?,?,?)').run(
      enterpriseId,
      data.id,
      data.occurred_at,
      JSON.stringify(data),
    );
  }
  function source(sourceId, revision, { includeBytes = false } = {}) {
    const row = db
      .prepare('SELECT data,bytes,active FROM ki_sources WHERE tenant=? AND id=? AND revision=?')
      .get(enterpriseId, sourceId, String(revision));
    if (!row)
      throw new KnowledgeError('SOURCE_NOT_FOUND', 'Source version not found in this enterprise');
    return {
      ...decode(row),
      active: Boolean(row.active),
      ...(includeBytes ? { bytes: Buffer.from(row.bytes) } : {}),
    };
  }
  function assertLink(sourceId, revision, entity) {
    if (
      !db
        .prepare(
          'SELECT 1 FROM ki_links WHERE tenant=? AND source_id=? AND revision=? AND entity_key=?',
        )
        .get(enterpriseId, sourceId, String(revision), entityKey(entity))
    ) {
      throw new KnowledgeError(
        'SOURCE_ENTITY_MISMATCH',
        'Source has not been assigned to this entity',
      );
    }
  }
  function putSource(input) {
    const asset = validateAsset(input, enterpriseId);
    return transaction(() => {
      // Library version numbers are monotonic. A slow import of v1 must never
      // retire an already received v2 just because its earlier response said current.
      if (/^[0-9]+$/.test(asset.revision)) {
        const known = db
          .prepare('SELECT revision FROM ki_sources WHERE tenant=? AND id=?')
          .all(enterpriseId, asset.source_id);
        if (
          known.some(
            (row) => /^[0-9]+$/.test(row.revision) && BigInt(row.revision) > BigInt(asset.revision),
          )
        )
          asset.is_current_version = false;
      }
      const previous = db
        .prepare('SELECT digest,data FROM ki_sources WHERE tenant=? AND id=? AND revision=?')
        .get(enterpriseId, asset.source_id, asset.revision);
      if (previous && previous.digest !== asset.sha256) {
        throw new KnowledgeError(
          'SOURCE_VERSION_CONFLICT',
          'The same immutable source version has different bytes',
        );
      }
      if (previous && !asset.is_current_version) {
        db.prepare('UPDATE ki_sources SET active=0 WHERE tenant=? AND id=? AND revision=?').run(
          enterpriseId,
          asset.source_id,
          asset.revision,
        );
      }
      if (!previous) {
        const metadata = { ...asset };
        const bytes = metadata.bytes;
        delete metadata.bytes;
        delete metadata.entity;
        metadata.acquired_at = new Date().toISOString();
        if (asset.is_current_version) {
          db.prepare('UPDATE ki_sources SET active=0 WHERE tenant=? AND id=?').run(
            enterpriseId,
            asset.source_id,
          );
        }
        db.prepare('INSERT INTO ki_sources VALUES (?,?,?,?,?,?,?)').run(
          enterpriseId,
          asset.source_id,
          asset.revision,
          asset.sha256,
          Number(asset.is_current_version),
          JSON.stringify(metadata),
          bytes,
        );
        event('source.received', {
          source_id: asset.source_id,
          revision: asset.revision,
          sha256: asset.sha256,
        });
      }
      db.prepare('INSERT OR IGNORE INTO ki_links VALUES (?,?,?,?,?)').run(
        enterpriseId,
        asset.source_id,
        asset.revision,
        entityKey(asset.entity),
        JSON.stringify(asset.entity),
      );
      return {
        ...source(asset.source_id, asset.revision),
        entity: asset.entity,
        duplicate: Boolean(previous),
      };
    });
  }
  function listSources(entity) {
    return db
      .prepare(
        `SELECT s.data,s.active FROM ki_sources s JOIN ki_links l
      ON s.tenant=l.tenant AND s.id=l.source_id AND s.revision=l.revision
      WHERE l.tenant=? AND l.entity_key=? ORDER BY s.rowid`,
      )
      .all(enterpriseId, entityKey(entity))
      .map((row) => ({ ...decode(row), active: Boolean(row.active) }));
  }
  function saveParse(sourceId, revision, parsed) {
    source(sourceId, revision);
    if (
      !parsed ||
      !['ready', 'partial', 'needs_processor', 'failed'].includes(parsed.status) ||
      !Array.isArray(parsed.segments) ||
      parsed.segments.length > 10000
    ) {
      throw new KnowledgeError('INVALID_PARSE', 'Invalid parser result');
    }
    const ids = new Set();
    let length = 0;
    for (const segment of parsed.segments) {
      requireText(segment.id, 'segment.id', 128);
      if (
        ids.has(segment.id) ||
        typeof segment.text !== 'string' ||
        !segment.locator ||
        typeof segment.method !== 'string'
      ) {
        throw new KnowledgeError(
          'INVALID_PARSE',
          'Segments must have unique IDs, text, locations and extraction methods',
        );
      }
      ids.add(segment.id);
      for (const character of segment.text) {
        if (character) length++;
      }
    }
    if (length > 250000)
      throw new KnowledgeError('PARSE_TOO_LARGE', 'Extracted text exceeds 250,000 characters');
    const data = { ...parsed, id: randomUUID(), created_at: new Date().toISOString() };
    db.prepare('INSERT INTO ki_parses VALUES (?,?,?,?,?,?)').run(
      enterpriseId,
      data.id,
      sourceId,
      String(revision),
      data.created_at,
      JSON.stringify(data),
    );
    event('source.parsed', {
      source_id: sourceId,
      revision: String(revision),
      parse_id: data.id,
      status: data.status,
    });
    return data;
  }
  function latestParse(sourceId, revision) {
    return decode(
      db
        .prepare(
          'SELECT data FROM ki_parses WHERE tenant=? AND source_id=? AND revision=? ORDER BY rowid DESC LIMIT 1',
        )
        .get(enterpriseId, sourceId, String(revision)),
    );
  }
  function isStale(fact) {
    return !fact.evidence.some((ref) =>
      db
        .prepare(
          'SELECT 1 FROM ki_sources WHERE tenant=? AND id=? AND revision=? AND digest=? AND active=1',
        )
        .get(enterpriseId, ref.source_id, ref.source_revision, ref.sha256),
    );
  }
  function getFact(id) {
    const fact = decode(
      db.prepare('SELECT data FROM ki_facts WHERE tenant=? AND id=?').get(enterpriseId, id),
    );
    if (!fact) throw new KnowledgeError('FACT_NOT_FOUND', 'Fact not found in this enterprise');
    return { ...fact, stale: isStale(fact) };
  }
  function listFacts(entity) {
    return db
      .prepare('SELECT data FROM ki_facts WHERE tenant=? AND entity_key=? ORDER BY rowid')
      .all(enterpriseId, entityKey(entity))
      .map((row) => {
        const fact = decode(row);
        return { ...fact, stale: isStale(fact) };
      });
  }
  function saveCandidate(entity, candidate) {
    const key = entityKey(entity);
    // Parse IDs change on retry, but identical evidence and values do not create duplicate facts.
    const identityEvidence = candidate.evidence.map((evidence) => {
      const ref = { ...evidence };
      delete ref.parse_id;
      return ref;
    });
    const id = stableId(enterpriseId, key, candidate.field, candidate.value, identityEvidence);
    const existing = db
      .prepare('SELECT 1 FROM ki_facts WHERE tenant=? AND id=?')
      .get(enterpriseId, id);
    if (existing) return getFact(id);
    for (const ref of candidate.evidence) {
      const origin = source(ref.source_id, ref.source_revision);
      assertLink(ref.source_id, ref.source_revision, entity);
      const parsed = decode(
        db
          .prepare(
            'SELECT data FROM ki_parses WHERE tenant=? AND id=? AND source_id=? AND revision=?',
          )
          .get(enterpriseId, ref.parse_id, ref.source_id, ref.source_revision),
      );
      const segment = parsed?.segments.find((item) => item.id === ref.segment_id);
      if (
        origin.sha256 !== ref.sha256 ||
        !segment ||
        !segment.text.includes(ref.quote) ||
        ref.method !== segment.method
      ) {
        throw new KnowledgeError(
          'INVALID_EVIDENCE',
          'Evidence must resolve to immutable source bytes and a stored parse',
        );
      }
    }
    const fact = {
      ...candidate,
      id,
      entity_key: key,
      status: 'candidate',
      created_at: new Date().toISOString(),
    };
    db.prepare('INSERT INTO ki_facts VALUES (?,?,?,?,?,?)').run(
      enterpriseId,
      id,
      key,
      fact.field,
      fact.status,
      JSON.stringify(fact),
    );
    return { ...fact, stale: isStale(fact) };
  }
  function writeFact(fact) {
    const data = { ...fact };
    delete data.stale;
    db.prepare('UPDATE ki_facts SET status=?,data=? WHERE tenant=? AND id=?').run(
      data.status,
      JSON.stringify(data),
      enterpriseId,
      data.id,
    );
  }
  function reviewFact(id, { action, replace = false, reason = '' }) {
    return transaction(() => {
      const fact = getFact(id);
      if (!['confirm', 'reject'].includes(action))
        throw new KnowledgeError('INVALID_REVIEW', 'Review action must be confirm or reject');
      if (fact.stale && action === 'confirm')
        throw new KnowledgeError(
          'STALE_EVIDENCE',
          'Import or provide current evidence before confirming this fact',
        );
      const status = action === 'confirm' ? 'confirmed' : 'rejected';
      if (fact.status === status && !replace) return fact;
      if (fact.status === 'superseded')
        throw new KnowledgeError(
          'SUPERSEDED_FACT',
          'A superseded fact cannot be restored by a repeated review',
        );
      const others = db
        .prepare(
          "SELECT data FROM ki_facts WHERE tenant=? AND entity_key=? AND field=? AND id<>? AND status IN ('candidate','confirmed')",
        )
        .all(enterpriseId, fact.entity_key, fact.field, id)
        .map(decode)
        .filter((item) => !sameValue(item.value, fact.value) && !isStale(item));
      if (fact.status === status && others.length === 0) return fact;
      if (action === 'confirm' && others.some((item) => item.status === 'confirmed') && !replace) {
        throw new KnowledgeError(
          'CONFIRMED_CONFLICT',
          'Resolving a confirmed conflict requires replace:true and a reason',
        );
      }
      if (action === 'confirm' && replace) {
        requireText(reason, 'correction reason', 2000);
        for (const previous of others) {
          writeFact({ ...previous, status: 'superseded', superseded_by: id });
          const correction = {
            id: randomUUID(),
            entity_key: fact.entity_key,
            field: fact.field,
            previous_value: previous.value,
            corrected_value: fact.value,
            reason,
            fact_id: id,
            previous_fact_id: previous.id,
            status: 'confirmed',
            actor_id: actorId,
            created_at: new Date().toISOString(),
          };
          db.prepare('INSERT INTO ki_corrections VALUES (?,?,?,?,?)').run(
            enterpriseId,
            correction.id,
            fact.entity_key,
            correction.created_at,
            JSON.stringify(correction),
          );
        }
      }
      writeFact({
        ...fact,
        status,
        reviewed_at: new Date().toISOString(),
        reviewed_by: actorId,
        review_reason: reason,
      });
      if (action === 'confirm')
        db.prepare('DELETE FROM ki_deferrals WHERE tenant=? AND entity_key=? AND field=?').run(
          enterpriseId,
          fact.entity_key,
          fact.field,
        );
      event(`fact.${action}`, { fact_id: id, replace, reason });
      return getFact(id);
    });
  }
  function saveAnalysis(sourceId, revision, entity, analysis) {
    assertLink(sourceId, revision, entity);
    const data = {
      ...analysis,
      source_id: sourceId,
      revision: String(revision),
      entity_key: entityKey(entity),
      analyzed_at: new Date().toISOString(),
    };
    db.prepare('INSERT OR REPLACE INTO ki_analyses VALUES (?,?,?,?,?)').run(
      enterpriseId,
      sourceId,
      String(revision),
      entityKey(entity),
      JSON.stringify(data),
    );
    event('source.analyzed', {
      source_id: sourceId,
      revision: String(revision),
      entity_key: entityKey(entity),
      status: analysis.status,
    });
    return data;
  }
  function listAnalyses(entity) {
    return db
      .prepare(
        `SELECT a.data FROM ki_analyses a JOIN ki_sources s
      ON s.tenant=a.tenant AND s.id=a.source_id AND s.revision=a.revision
      WHERE a.tenant=? AND a.entity_key=? AND s.active=1 ORDER BY a.rowid`,
      )
      .all(enterpriseId, entityKey(entity))
      .map(decode);
  }
  function corrections(entity) {
    // Retired correction targets never keep teaching an obsolete value.
    return db
      .prepare('SELECT data FROM ki_corrections WHERE tenant=? AND entity_key=? ORDER BY rowid')
      .all(enterpriseId, entityKey(entity))
      .map(decode)
      .filter((row) => {
        const target = getFact(row.fact_id);
        return target.status === 'confirmed' && !target.stale;
      });
  }
  function setDeferral(entity, field, reason) {
    requireText(reason, 'deferral reason', 1000);
    const data = { field, reason, actor_id: actorId, created_at: new Date().toISOString() };
    db.prepare('INSERT OR REPLACE INTO ki_deferrals VALUES (?,?,?,?)').run(
      enterpriseId,
      entityKey(entity),
      field,
      JSON.stringify(data),
    );
    event('question.deferred', { entity_key: entityKey(entity), ...data });
    return data;
  }
  function linkSupplement(entity, sourceId, revision, replacementId, replacementRevision, reason) {
    assertLink(sourceId, revision, entity);
    assertLink(replacementId, replacementRevision, entity);
    requireText(reason, 'supplement reason', 2000);
    const data = {
      source_id: sourceId,
      revision: String(revision),
      replacement_source_id: replacementId,
      replacement_revision: String(replacementRevision),
      reason,
      actor_id: actorId,
      created_at: new Date().toISOString(),
    };
    return transaction(() => {
      db.prepare('INSERT OR REPLACE INTO ki_supplements VALUES (?,?,?,?,?)').run(
        enterpriseId,
        entityKey(entity),
        sourceId,
        String(revision),
        JSON.stringify(data),
      );
      event('source.supplemented', { entity_key: entityKey(entity), ...data });
      return data;
    });
  }
  return {
    enterpriseId,
    actorId,
    transaction,
    event,
    putSource,
    source,
    assertLink,
    listSources,
    saveParse,
    latestParse,
    saveCandidate,
    getFact,
    listFacts,
    reviewFact,
    saveAnalysis,
    listAnalyses,
    corrections,
    setDeferral,
    linkSupplement,
    supplements: (entity) =>
      db
        .prepare('SELECT data FROM ki_supplements WHERE tenant=? AND entity_key=?')
        .all(enterpriseId, entityKey(entity))
        .map(decode),
    deferrals: (entity) =>
      db
        .prepare('SELECT data FROM ki_deferrals WHERE tenant=? AND entity_key=?')
        .all(enterpriseId, entityKey(entity))
        .map(decode),
    resumeField: (entity, field) =>
      db
        .prepare('DELETE FROM ki_deferrals WHERE tenant=? AND entity_key=? AND field=?')
        .run(enterpriseId, entityKey(entity), field),
    audit: () =>
      db
        .prepare('SELECT data FROM ki_events WHERE tenant=? ORDER BY rowid')
        .all(enterpriseId)
        .map(decode),
    close: () => db.close(),
  };
}
