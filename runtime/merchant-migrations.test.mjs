import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { merchantMigration } from '../scripts/merchant-migration.mjs';

test('the journal applies every migration as individual SQLite statements and preserves existing enquiry data', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  assert.deepEqual(journal.entries.map(x => x.idx), [0, 1, 2, 3, 4, 5, 6]);
  db.exec('PRAGMA foreign_keys = ON; CREATE TABLE _applied (tag TEXT PRIMARY KEY)');
  const apply = async () => {
    for (const entry of journal.entries) {
      if (db.prepare('SELECT tag FROM _applied WHERE tag=?').get(entry.tag)) continue;
      const sql = await readFile(new URL(`../drizzle/${entry.tag}.sql`, import.meta.url), 'utf8');
      db.exec('BEGIN');
      try {
        for (const statement of sql.split('--> statement-breakpoint').map(x => x.trim()).filter(Boolean)) db.prepare(statement).run();
        if (entry.idx === 0) {
          const columns = db.prepare('PRAGMA table_info(buyer_enquiries)').all().map(row => row.name);
          db.prepare(`INSERT INTO buyer_enquiries (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`)
            .run(...columns.map(column => column === 'status' ? 'new' : `fixture-${column}`));
        }
        db.prepare('INSERT INTO _applied VALUES(?)').run(entry.tag); db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
  await apply();
  const before = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  for (const name of ['buyer_enquiries', 'buyer_marketing_outbox', 'supplier_quote_submissions', 'sourcing_sessions', 'merchant_support_threads', 'merchant_knowledge_versions', 'merchant_claim_states', 'merchant_agentbot_jobs']) {
    assert.ok(before.some(row => row.name === name), `migration table ${name} exists`);
  }
  await apply(); assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM _applied').get().count, 7);
  assert.equal(db.prepare('SELECT email FROM buyer_enquiries WHERE id=?').get('fixture-id').email, 'fixture-email');
  for (const index of ['idx_sourcing_sessions_tenant_status_updated', 'idx_sourcing_sessions_buyer_updated', 'merchant_support_thread_writer', 'merchant_agentbot_ready_idx']) {
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(index), `index ${index} is applied`);
  }
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('unified merchant migration exactly matches independently reviewed schema fragments', async () => {
  const checkedIn = await readFile(new URL('../drizzle/0006_merchant_support.sql', import.meta.url), 'utf8');
  assert.equal(checkedIn, await merchantMigration());
});
