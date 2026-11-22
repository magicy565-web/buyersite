// Isolated, file-backed SQLite checks for the committed Drizzle migration order.
// Never opens production D1 or sends external requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const dir = fileURLToPath(new URL('../drizzle/', import.meta.url));
const journal = JSON.parse(readFileSync(join(dir, 'meta/_journal.json'), 'utf8'));
const tags = [
  '0000_buyer_enquiries', '0001_buyer_events', '0002_enquiry_context',
  '0003_marketing_outbox', '0004_supplier_quote_submissions',
];
const migration = (tag) => {
  const sql = readFileSync(join(dir, tag + '.sql'), 'utf8');
  return { sql, hash: createHash('sha256').update(sql).digest('hex') };
};
function withSqlite(t) {
  const directory = mkdtempSync(join(tmpdir(), 'buyersite-d1-'));
  const db = new DatabaseSync(join(directory, 'isolated.sqlite'));
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  return db;
}
// Test-only journal runner; actual deployment requires Wrangler local verification.
function apply(db, through = 4) {
  db.exec('CREATE TABLE IF NOT EXISTS __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC NOT NULL)');
  const previous = db.prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at').all();
  for (const [i, item] of previous.entries()) {
    assert.ok(journal.entries[i], 'unknown recorded migration');
    assert.equal(item.created_at, journal.entries[i].when, 'migration order changed');
    assert.equal(item.hash, migration(journal.entries[i].tag).hash, 'migration SQL changed');
  }
  for (let i = previous.length; i <= through; i++) {
    const entry = journal.entries[i];
    const { sql, hash } = migration(entry.tag);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of sql.split('--> statement-breakpoint')) {
        if (statement.trim()) db.exec(statement);
      }
      db.prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)').run(hash, entry.when);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db.prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations').get().n;
}
const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
function insertQuote(db, tenant, submission) {
  db.prepare('INSERT INTO supplier_quote_submissions (tenant_id,submission_id,rfq_id,supplier_id,rfq_snapshot_hash,snapshot_hash,status,snapshot_json,submitted_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(tenant, submission, 'rfq', 'supplier', 'rfqhash', 'quotehash', 'received', '{"minorUnits":100}', '2026-11-20T00:00:00Z');
}
test('journal is monotonic and every numbered SQL file has exactly one entry', () => {
  assert.equal(journal.version, '7');
  assert.equal(journal.dialect, 'sqlite');
  assert.deepEqual(journal.entries.map(x => x.tag), tags);
  assert.deepEqual(journal.entries.map(x => x.idx), [0, 1, 2, 3, 4]);
  assert.deepEqual(readdirSync(dir).filter(name => /^\d{4}_.*\.sql$/.test(name)).sort(), tags.map(x => x + '.sql'));
  for (let i = 1; i < journal.entries.length; i++) {
    assert.ok(journal.entries[i].when > journal.entries[i - 1].when);
  }
});
test('upgrade 0002 to 0004 preserves existing enquiries, analytics and rate limits', (t) => {
  const db = withSqlite(t);
  assert.equal(apply(db, 2), 3);
  db.prepare('INSERT INTO buyer_enquiries (id,site_slug,idempotency_key_hash,payload_hash,created_at,updated_at,status,email,name,company,material,quantity,application,delivery,page_path,attribution_json,consent_version,consent_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('receipt', 'edition-a', 'idemhash', 'payloadhash', '2026-11-20', '2026-11-20', 'new', 'buyer@example.invalid', 'Buyer', 'Test', 'hardware', '100', 'doors', 'US', '/enquiry', '{}', 'v1', '2026-11-20');
  db.prepare("INSERT INTO buyer_event_daily VALUES ('edition-a','2026-11-20','page_view','/',7)").run();
  db.prepare("INSERT INTO buyer_rate_limits VALUES ('edition-a','events','key',100,2,200)").run();
  const enquiry = db.prepare('SELECT * FROM buyer_enquiries').get();
  const event = db.prepare('SELECT * FROM buyer_event_daily').get();
  const rate = db.prepare('SELECT * FROM buyer_rate_limits').get();
  assert.equal(apply(db), 5);
  assert.ok(hasTable(db, 'buyer_marketing_outbox'));
  assert.ok(hasTable(db, 'supplier_quote_submissions'));
  assert.deepEqual(db.prepare('SELECT * FROM buyer_enquiries').get(), enquiry);
  assert.deepEqual(db.prepare('SELECT * FROM buyer_event_daily').get(), event);
  assert.deepEqual(db.prepare('SELECT * FROM buyer_rate_limits').get(), rate);
});
test('repeated journal application is a no-op, retaining the quote and schema', (t) => {
  const db = withSqlite(t);
  apply(db);
  insertQuote(db, 'tenant-a', 'quote-one');
  const schema = db.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all();
  const quote = db.prepare('SELECT * FROM supplier_quote_submissions').get();
  assert.equal(apply(db), 5);
  assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all(), schema);
  assert.deepEqual(db.prepare('SELECT * FROM supplier_quote_submissions').get(), quote);
});
test('marketing-only 0003 upgrade retains existing pending outbox data', (t) => {
  const db = withSqlite(t);
  assert.equal(apply(db, 3), 4);
  db.prepare("INSERT INTO buyer_marketing_outbox (id,site_slug,event_id,campaign_id,event_type,payload_json,status,attempts,next_attempt_at,created_at,updated_at) VALUES ('o1','edition-a','event1','campaign1','page_view','{}','pending',0,0,'2026-11-20','2026-11-20')").run();
  const previous = db.prepare('SELECT * FROM buyer_marketing_outbox').get();
  assert.equal(apply(db), 5);
  assert.deepEqual(db.prepare('SELECT * FROM buyer_marketing_outbox').get(), previous);
});
test('old unjournaled quote table and data survive registration at 0004', (t) => {
  const db = withSqlite(t);
  apply(db, 2);
  db.exec(migration('0004_supplier_quote_submissions').sql);
  insertQuote(db, 'tenant-legacy', 'legacy-quote');
  const previous = db.prepare('SELECT * FROM supplier_quote_submissions').get();
  assert.equal(apply(db), 5);
  assert.deepEqual(db.prepare('SELECT * FROM supplier_quote_submissions').get(), previous);
  assert.ok(hasTable(db, 'buyer_marketing_outbox'));
});
test('quote uniqueness and JSON constraints reject invalid or repeated receipts', (t) => {
  const db = withSqlite(t);
  apply(db);
  insertQuote(db, 'tenant-a', 'quote-one');
  assert.throws(() => insertQuote(db, 'tenant-a', 'quote-one'), /UNIQUE constraint failed/);
  assert.throws(() => insertQuote(db, 'tenant-a', 'quote-two'), /UNIQUE constraint failed/);
  insertQuote(db, 'tenant-b', 'quote-one');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM supplier_quote_submissions').get().n, 2);
  assert.throws(() => db.prepare("INSERT INTO supplier_quote_submissions (tenant_id,submission_id,rfq_id,supplier_id,rfq_snapshot_hash,snapshot_hash,status,snapshot_json,submitted_at) VALUES ('tenant-a','invalid','rfq','supplier','rfqhash','different','received','not-json','2026-11-20')").run(), /CHECK constraint failed/);
});
test('outbox event uniqueness is per edition, not global', (t) => {
  const db = withSqlite(t);
  apply(db);
  const insert = db.prepare('INSERT INTO buyer_marketing_outbox (id,site_slug,event_id,campaign_id,event_type,payload_json,status,attempts,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const rest = ['event1', 'campaign1', 'page_view', '{}', 'pending', 0, 0, '2026-11-20', '2026-11-20'];
  insert.run('outbox-a', 'edition-a', ...rest);
  insert.run('outbox-b', 'edition-b', ...rest);
  assert.throws(() => insert.run('outbox-c', 'edition-a', ...rest), /UNIQUE constraint failed/);
  assert.equal(db.prepare('SELECT COUNT(DISTINCT site_slug) AS n FROM buyer_marketing_outbox').get().n, 2);
});
