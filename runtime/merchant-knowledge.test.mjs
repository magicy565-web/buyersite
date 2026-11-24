import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMerchantKnowledgeRepository } from './merchant-knowledge.mjs';
import { approvedFact, fixtureNow, merchantFixture, merchantSchema, merchantTestDatabase } from './test-support/merchant-sqlite.mjs';

const owner = { actorId: 'owner-one', now: fixtureNow };
async function publish(repo, facts = [approvedFact()], expectedRevision = null) {
  const saved = await repo.saveVersion({ facts }, owner);
  await repo.activateVersion(saved.revision, { ...owner, expectedRevision });
  return saved;
}

test('publishes only the explicitly approved public projection and exact citations', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const repo = createMerchantKnowledgeRepository(db, merchantFixture);
  const saved = await publish(repo, [approvedFact({ internal_note: 'DO NOT EXPOSE', customer_email: 'private@example.org' }),
    approvedFact({ evidence_id: 'internal', audience: 'internal', value: 'PRIVATE MEMORY' }),
    approvedFact({ evidence_id: 'draft', publication_permission: 'pending', value: 'DRAFT MEMORY' })]);
  assert.equal(saved.fact_count, 1); assert.equal(saved.excluded_count, 2);
  const detachedSearch = repo.search;
  const result = await detachedSearch('wool', { now: fixtureNow });
  assert.equal(result.results[0].value, '100% wool');
  assert.equal(result.results[0].source_url, 'https://merchant.example/fabric#specification');
  assert.equal(result.results[0].captured_at, '2026-11-20T00:00:00.000Z');
  assert.equal(result.inference_performed, false);
  const raw = db.sqlite.prepare('SELECT bundle_json FROM merchant_knowledge_versions').get().bundle_json;
  for (const secret of ['DO NOT EXPOSE', 'private@example.org', 'PRIVATE MEMORY', 'DRAFT MEMORY']) assert.equal(raw.includes(secret), false);
  assert.equal(JSON.stringify(result).includes('authorizationRef'), false);
  assert.equal(JSON.stringify(result).includes('approved_by'), false);
});

test('tenant and merchant keys constrain every persisted lookup and activation', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const a = createMerchantKnowledgeRepository(db, merchantFixture), saved = await publish(a);
  const b = createMerchantKnowledgeRepository(db, { ...merchantFixture, merchantId: 'merchant-two' });
  const c = createMerchantKnowledgeRepository(db, { ...merchantFixture, siteSlug: 'other-edition' });
  for (const other of [b, c]) {
    assert.equal(await other.getVersion(saved.revision), null);
    assert.equal(await other.getActive(), null);
    assert.deepEqual((await other.search('wool')).results, []);
    await assert.rejects(other.activateVersion(saved.revision, { ...owner, expectedRevision: null }), { code: 'KNOWLEDGE_VERSION_NOT_FOUND' });
  }
  await assert.rejects(a.saveVersion({ facts: [approvedFact({ merchant_id: 'merchant-two' })] }, owner), { code: 'KNOWLEDGE_MERCHANT_MISMATCH' });
});

test('version insertion is immutable, idempotent, and has a reproducible content revision', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const repo = createMerchantKnowledgeRepository(db, merchantFixture);
  const first = await repo.saveVersion({ facts: [approvedFact()] }, owner);
  const again = await repo.saveVersion({ facts: [approvedFact()] }, { ...owner, now: '2026-11-25T01:00:00.000Z' });
  assert.equal(first.revision, again.revision);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM merchant_knowledge_versions').get().count, 1);
  assert.throws(() => db.sqlite.prepare('UPDATE merchant_knowledge_versions SET bundle_json = ?').run('{}'), /Immutable/);
  const changed = await repo.saveVersion({ facts: [approvedFact({ value: '80% wool' })] }, owner);
  assert.notEqual(changed.revision, first.revision);
  assert.equal((await repo.getVersion(first.revision, { now: fixtureNow })).facts[0].value, '100% wool');
});

test('activation compare-and-swap rejects a stale competing publisher', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const repo = createMerchantKnowledgeRepository(db, merchantFixture), base = await publish(repo);
  const a = await repo.saveVersion({ facts: [approvedFact({ value: '90% wool' })] }, owner);
  const b = await repo.saveVersion({ facts: [approvedFact({ value: '80% wool' })] }, owner);
  await repo.activateVersion(a.revision, { ...owner, expectedRevision: base.revision });
  await assert.rejects(repo.activateVersion(b.revision, { ...owner, expectedRevision: base.revision }), { code: 'KNOWLEDGE_REVISION_CONFLICT' });
  assert.equal((await repo.getActive({ now: fixtureNow })).revision, a.revision);
});

test('commercial facts require expiry and expired facts never reach search or a public bundle', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const repo = createMerchantKnowledgeRepository(db, merchantFixture);
  await assert.rejects(repo.saveVersion({ facts: [approvedFact({ kind: 'price' })] }, owner), { code: 'COMMERCIAL_FACT_EXPIRY_REQUIRED' });
  await publish(repo, [approvedFact(), approvedFact({ evidence_id: 'fabric-price', kind: 'price', claim: 'Unit price', value: '12.50 USD', valid_until: '2026-11-24T01:01:00Z' })]);
  assert.equal((await repo.search('price', { now: fixtureNow })).results.length, 1);
  const later = { now: '2026-11-24T01:02:00Z' };
  assert.equal((await repo.search('price', later)).results.length, 0);
  assert.equal((await repo.getActive(later)).facts.length, 1);
  assert.equal((await repo.getActive({ now: '2026-11-19T00:00:00Z' })).facts.length, 0);
  await assert.rejects(repo.saveVersion({ facts: [approvedFact({ captured_at: '2030-01-01T00:00:00Z' })] }, owner), { code: 'INVALID_FACT_VALIDITY' });
});

test('authorized binding rotation and explicit revision pins fail closed', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const repo = createMerchantKnowledgeRepository(db, merchantFixture), saved = await publish(repo);
  const rotated = createMerchantKnowledgeRepository(db, { ...merchantFixture, authorizationRef: 'revoked-and-replaced' });
  await assert.rejects(rotated.getActive(), { code: 'KNOWLEDGE_BINDING_CHANGED' });
  const pinned = createMerchantKnowledgeRepository(db, { ...merchantFixture, knowledgeRevision: '0'.repeat(64) });
  await assert.rejects(pinned.getActive(), { code: 'KNOWLEDGE_REVISION_PINNED' });
  await assert.rejects(pinned.activateVersion(saved.revision, { ...owner, expectedRevision: saved.revision }), { code: 'KNOWLEDGE_REVISION_PINNED' });
});

test('schema reapplication preserves existing rows and file-backed knowledge survives reopening', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'merchant-knowledge-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.sqlite');
  let db = merchantTestDatabase(path), repo = createMerchantKnowledgeRepository(db, merchantFixture);
  const saved = await publish(repo);
  db.sqlite.exec(merchantSchema);
  assert.equal((await repo.getActive()).revision, saved.revision);
  db.close(); db = merchantTestDatabase(path); t.after(() => db.close());
  repo = createMerchantKnowledgeRepository(db, merchantFixture);
  assert.equal((await repo.getActive()).revision, saved.revision);
});

test('rejects invalid publication, duplicate facts, missing actor and unsafe URLs', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const repo = createMerchantKnowledgeRepository(db, merchantFixture);
  await assert.rejects(repo.saveVersion({ facts: [approvedFact()] }), { code: 'OWNER_ACTOR_REQUIRED' });
  await assert.rejects(repo.saveVersion({ facts: [approvedFact(), approvedFact()] }, owner), { code: 'DUPLICATE_MERCHANT_FACT' });
  await assert.rejects(repo.saveVersion({ facts: [approvedFact({ publication_permission: 'draft' })] }, owner), { code: 'NO_APPROVED_PUBLIC_FACTS' });
  await assert.rejects(repo.saveVersion({ facts: [approvedFact({ source_url: 'https://user:password@merchant.example/fabric' })] }, owner), { code: 'INVALID_MERCHANT_URL' });
  await assert.rejects(repo.saveVersion({ facts: [approvedFact()], claimed: true }, owner), { code: 'INVALID_KNOWLEDGE_BUNDLE' });
});
