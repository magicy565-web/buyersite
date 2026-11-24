import test from 'node:test';
import assert from 'node:assert/strict';
import { pruneMerchantQueue } from './merchant-maintenance.mjs';
import { createD1MerchantAgentBotStore } from './merchant-agentbot.mjs';
import { testDatabase } from './merchant-test-helpers.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-24T12:00:00Z');
const CUTOFF = NOW - 30 * DAY;
const merchant = { merchantId: 'merchant-one', siteSlug: 'edition-one', name: 'Example Merchant',
  origin: 'https://merchant.example', privacyUrl: 'https://merchant.example/privacy', authorizationRef: 'merchant-authorization',
  chatwoot: { baseUrl: 'https://chat.example', accountId: 11, websiteInboxId: 21, apiInboxId: 22 } };
const scope = { merchantId: merchant.merchantId, siteSlug: merchant.siteSlug, chatwootOrigin: merchant.chatwoot.baseUrl,
  accountId: merchant.chatwoot.accountId, inboxIds: [merchant.chatwoot.websiteInboxId, merchant.chatwoot.apiInboxId] };

function setup(t) {
  const database = testDatabase(t, ['merchant-agentbot.schema.sql', 'merchant-support.schema.sql']);
  let nextMessage = 100;
  function insert(overrides = {}) {
    const row = { id: crypto.randomUUID(), site_slug: merchant.siteSlug, merchant_id: merchant.merchantId,
      chatwoot_origin: merchant.chatwoot.baseUrl, account_id: 11, inbox_id: 21, conversation_id: 30, message_id: nextMessage++,
      payload_hash: 'a'.repeat(64), payload_json: JSON.stringify({ message: { content: 'PRIVATE CUSTOMER QUESTION' } }),
      answer_json: JSON.stringify({ text: 'PRIVATE PROPOSED ANSWER' }), delivery_id: 'delivery-reference',
      status: 'delivered', action: 'answer', knowledge_revision: 'b'.repeat(64), reason: 'RETAINED_REASON',
      attempts: 2, next_attempt_at: CUTOFF - DAY, lease_token: 'retained-lease-token', lease_until: CUTOFF + 1000,
      sent_message_id: 999, created_at: CUTOFF - DAY, updated_at: CUTOFF, ...overrides };
    const fields = Object.keys(row);
    database.sqlite.prepare(`INSERT INTO merchant_agentbot_jobs (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`).run(...Object.values(row));
    return row;
  }
  const get = id => ({ ...database.sqlite.prepare('SELECT * FROM merchant_agentbot_jobs WHERE id = ?').get(id) });
  return { ...database, insert, get };
}

test('redacts old finished bodies in both inboxes while retaining every tombstone field and customer receipt', async t => {
  const h = setup(t), old = [];
  for (const status of ['delivered', 'handed_off', 'ignored', 'unknown', 'dead']) {
    for (const inbox_id of [21, 22]) old.push(h.insert({ status, inbox_id }));
  }
  h.sqlite.prepare(`INSERT INTO merchant_support_operations
    (site_slug, merchant_id, id, thread_id, principal_hash, binding_hash, key_hash, kind, payload_hash, state, lease_token, lease_until, result_json, created_at, updated_at)
    VALUES (?, ?, 'receipt-one', 'thread-one', 'private-identity-hash', 'binding-hash', 'request-key-hash', 'message', 'request-payload-hash', 'uncertain', 'receipt-lease', ?, ?, ?, ?)`)
    .run(merchant.siteSlug, merchant.merchantId, CUTOFF, '{"needsReconciliation":true}', CUTOFF - DAY, CUTOFF);
  const receipt = h.sqlite.prepare('SELECT * FROM merchant_support_operations').get();
  assert.equal(await pruneMerchantQueue(h.DB, merchant, { now: NOW }), 10);
  for (const original of old) {
    const row = h.get(original.id);
    assert.deepEqual(row, { ...original, payload_json: '{}', answer_json: null });
    assert.equal(JSON.stringify(row).includes('PRIVATE CUSTOMER'), false);
    assert.equal(JSON.stringify(row).includes('PRIVATE PROPOSED'), false);
  }
  assert.deepEqual(h.sqlite.prepare('SELECT * FROM merchant_support_operations').get(), receipt);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM merchant_agentbot_jobs').get().count, old.length);
  assert.equal(await pruneMerchantQueue(h.DB, merchant, { now: NOW }), 0);
  assert.deepEqual(h.sqlite.prepare('SELECT * FROM merchant_support_operations').get(), receipt);
});

test('retention is scoped to the exact site, merchant, Chatwoot instance, account and two inboxes', async t => {
  const h = setup(t);
  const own = h.insert({ message_id: 42 });
  const others = [
    { site_slug: 'another-edition' }, { merchant_id: 'merchant-two' },
    { chatwoot_origin: 'https://previous-chat.example' }, { account_id: 12 }, { inbox_id: 23 },
  ].map(changed => h.insert({ message_id: 42, ...changed }));
  assert.equal(await pruneMerchantQueue(h.DB, merchant, { now: NOW }), 1);
  assert.equal(h.get(own.id).payload_json, '{}');
  for (const row of others) assert.deepEqual(h.get(row.id), row);
});

test('active jobs and recently updated finished jobs stay unchanged regardless of their creation date', async t => {
  const h = setup(t);
  const untouched = ['queued', 'processing', 'sending'].map(status => h.insert({ status, updated_at: CUTOFF - DAY }));
  untouched.push(h.insert({ status: 'unknown', created_at: CUTOFF - 90 * DAY, updated_at: CUTOFF + 1 }));
  untouched.push(h.insert({ status: 'dead', created_at: CUTOFF - 90 * DAY, updated_at: NOW }));
  const boundary = h.insert({ updated_at: CUTOFF });
  assert.equal(await pruneMerchantQueue(h.DB, merchant, { now: NOW }), 1);
  assert.deepEqual(h.get(boundary.id), { ...boundary, payload_json: '{}', answer_json: null });
  for (const row of untouched) assert.deepEqual(h.get(row.id), row);
});

test('redacted unknown and dead jobs still block their conversation and retain enqueue deduplication', async t => {
  const h = setup(t), store = createD1MerchantAgentBotStore(h.DB);
  const unknown = h.insert({ status: 'unknown', conversation_id: 40, message_id: 10, sent_message_id: null });
  const dead = h.insert({ status: 'dead', conversation_id: 41, message_id: 20, sent_message_id: null });
  const queuedJob = (conversationId, messageId) => ({ id: crypto.randomUUID(), ...scope, inboxId: 21, conversationId, messageId,
    payloadHash: 'c'.repeat(64), payload: { message: { content: 'NEW QUESTION' } }, deliveryId: null, now: NOW });
  await store.enqueue(queuedJob(40, 11)); await store.enqueue(queuedJob(41, 21));
  const independent = queuedJob(42, 30); await store.enqueue(independent);
  assert.equal(await pruneMerchantQueue(h.DB, merchant, { now: NOW }), 2);
  for (const original of [unknown, dead]) {
    const row = await store.get({ ...scope, jobId: original.id });
    assert.deepEqual(row.payload, {}); assert.equal(row.answer, null); assert.equal(row.status, original.status);
  }
  const claimed = await store.claim({ ...scope, now: NOW });
  assert.equal(claimed.id, independent.id);
  assert.equal(await store.claim({ ...scope, now: NOW }), null);
  const replay = { ...queuedJob(40, 10), payloadHash: unknown.payload_hash, payload: JSON.parse(unknown.payload_json) };
  assert.deepEqual(await store.enqueue(replay), { id: unknown.id, duplicate: true, conflict: false });
  assert.deepEqual(await store.enqueue({ ...replay, payloadHash: 'd'.repeat(64) }), { id: unknown.id, duplicate: true, conflict: true });
  assert.deepEqual(h.get(unknown.id), { ...unknown, payload_json: '{}', answer_json: null });
  assert.deepEqual(h.get(dead.id), { ...dead, payload_json: '{}', answer_json: null });
});

test('each maintenance pass redacts at most 500 rows and repeated passes converge without deleting jobs', async t => {
  const h = setup(t);
  for (let index = 0; index < 601; index++) h.insert({ inbox_id: index % 2 ? 21 : 22 });
  assert.equal(await pruneMerchantQueue(h.DB, merchant, { now: NOW }), 500);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) AS count FROM merchant_agentbot_jobs WHERE payload_json <> '{}'").get().count, 101);
  assert.equal(await pruneMerchantQueue(h.DB, merchant, { now: NOW }), 101);
  assert.equal(await pruneMerchantQueue(h.DB, merchant, { now: NOW }), 0);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM merchant_agentbot_jobs').get().count, 601);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM merchant_agentbot_jobs WHERE updated_at <> ?').get(CUTOFF).count, 0);
});

test('retention and clock validation fail before SQL and both documented retention boundaries are accepted', async t => {
  let prepared = 0;
  const noSql = { prepare() { prepared++; throw Error('No SQL expected.'); } };
  for (const retentionDays of [0, -1, 366, 1.5, NaN, Infinity, '30', null]) {
    await assert.rejects(pruneMerchantQueue(noSql, merchant, { now: NOW, retentionDays }), { code: 'INVALID_QUEUE_RETENTION' });
  }
  for (const now of [-1, NOW + 0.5, NaN, Infinity, '2026-11-24', Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(pruneMerchantQueue(noSql, merchant, { now }), { code: 'INVALID_QUEUE_CLOCK' });
  }
  assert.equal(prepared, 0);
  const h = setup(t);
  const oldest = h.insert({ updated_at: NOW - 365 * DAY });
  const yesterday = h.insert({ updated_at: NOW - DAY });
  assert.equal(await pruneMerchantQueue(h.DB, merchant, { now: NOW, retentionDays: 365 }), 1);
  assert.equal(h.get(oldest.id).payload_json, '{}'); assert.equal(h.get(yesterday.id).payload_json, yesterday.payload_json);
  assert.equal(await pruneMerchantQueue(h.DB, merchant, { now: NOW, retentionDays: 1 }), 1);
  await assert.rejects(pruneMerchantQueue(null, merchant, { now: NOW }), { code: 'QUEUE_STORE_UNAVAILABLE' });
  await assert.rejects(pruneMerchantQueue(h.DB, { ...merchant, chatwoot: { ...merchant.chatwoot, apiInboxId: null } }, { now: NOW }), { code: 'INCOMPLETE_QUEUE_BINDING' });
});
