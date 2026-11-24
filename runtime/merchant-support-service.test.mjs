import test from 'node:test';
import assert from 'node:assert/strict';
import { createMerchantSupportService } from './merchant-support-service.mjs';
import { readMerchantBinding } from './merchant-binding.mjs';
import { testDatabase } from './merchant-test-helpers.mjs';

const merchant = { merchantId: 'merchant-a', siteSlug: 'material-notes', name: 'Merchant A', origin: 'https://shop.example', privacyUrl: 'https://shop.example/privacy', authorizationRef: 'approval-1', chatwoot: { baseUrl: 'https://chat.example', accountId: 11, websiteInboxId: 21, apiInboxId: 22 } };
const principal = { issuer: 'https://auth.example', subject: 'buyer-a', scopes: ['merchant:support:read', 'merchant:support:write'] };
const consent = { accepted: true, version: 'merchant-support-v1' };
function setup(t, overrides = {}) {
  const { sqlite, DB } = testDatabase(t);
  const calls = []; let sequence = 100;
  const remote = { id: 30, status: 'pending', accountId: 11, inboxId: 22, contactId: 40 };
  const client = {
    async createContact(input) { calls.push(['contact', input]); return { id: 40, sourceId: 'opaque-contact' }; },
    async createConversation(input) { calls.push(['start', input]); return { ...remote }; },
    async getConversation(input) { calls.push(['get', input]); return { ...remote }; },
    async sendIncoming(input) { calls.push(['send', input]); return { id: ++sequence }; },
    async listPublicMessages() { return { messages: [{ id: 101, content: 'Public answer', private: false, message_type: 'outgoing', created_at: 123 }, { id: 102, content: 'PRIVATE STAFF NOTE', private: true }, { id: 99, content: 'Old', private: false }], nextCursor: 102 }; },
    async requestHuman() { calls.push(['human']); remote.status = 'open'; return { status: 'open' }; },
    ...overrides.client,
  };
  const options = { db: DB, merchant, chatwoot: client, knowledge: { search: async () => ({ facts: [] }) }, ...overrides, chatwoot: client };
  const service = createMerchantSupportService(options);
  const start = (args = {}) => service.startConversation({ principal, merchantId: merchant.merchantId, message: 'Can you help?', idempotencyKey: crypto.randomUUID(), consent, ...args });
  return { sqlite, DB, service, start, calls, remote, client, options };
}

test('binding is public, explicitly authorized and fixed to canonical edition and distinct inboxes', () => {
  const config = { siteSlug: merchant.siteSlug, origin: merchant.origin, publication: 'public' };
  const env = { BUYERSITE_MERCHANT_SUPPORT_ENABLED: 'true', BUYERSITE_MERCHANT_CONFIG: JSON.stringify({ version: 1, authorized: true, ...merchant }) };
  assert.equal(readMerchantBinding(config, env).merchantId, merchant.merchantId);
  assert.equal(readMerchantBinding({ ...config, publication: 'private' }, env), null);
  for (const bad of [{ authorized: false }, { origin: 'https://another.example' }, { siteSlug: 'another-site' }, { chatwoot: { ...merchant.chatwoot, apiInboxId: 21 } }]) {
    assert.equal(readMerchantBinding(config, { ...env, BUYERSITE_MERCHANT_CONFIG: JSON.stringify({ version: 1, authorized: true, ...merchant, ...bad }) }), null);
  }
});

test('durable receipt replays once, rejects changed content and does not persist raw OAuth identity or messages', async t => {
  const { start, calls, sqlite } = setup(t); const idempotencyKey = crypto.randomUUID();
  const first = await start({ idempotencyKey }); const replay = await start({ idempotencyKey });
  assert.equal(first.status, 'delivered'); assert.deepEqual(replay, first);
  assert.equal(calls.filter(x => x[0] === 'start').length, 1);
  await assert.rejects(start({ idempotencyKey, message: 'Different message' }), { code: 'IDEMPOTENCY_CONFLICT' });
  const rows = JSON.stringify(sqlite.prepare('SELECT * FROM merchant_support_threads').all());
  assert.equal(rows.includes('buyer-a'), false); assert.equal(rows.includes('Can you help?'), false);
  assert.match(JSON.parse(JSON.stringify(calls[0][1])).identifier, /^bs_[a-f0-9]{64}$/);
});

test('consent, OAuth scope and merchant ownership are checked before writes', async t => {
  const { start, calls } = setup(t);
  await assert.rejects(start({ consent: { accepted: false } }), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(start({ principal: { ...principal, scopes: ['merchant:support:read'] } }), { code: 'SCOPE_REQUIRED' });
  await assert.rejects(start({ merchantId: 'other-merchant' }), { code: 'MERCHANT_NOT_FOUND' });
  await assert.rejects(start({ principal: null }), { code: 'AUTH_REQUIRED' });
  assert.equal(calls.length, 0);
});

test('conversation reads are bound to issuer, subject, merchant and remote account/contact/inbox', async t => {
  const { start, service, remote, options } = setup(t); const started = await start();
  for (const other of [{ ...principal, subject: 'buyer-b' }, { ...principal, issuer: 'https://other-auth.example' }]) {
    await assert.rejects(service.getUpdates({ principal: other, conversationId: started.conversationId }), { code: 'CONVERSATION_NOT_FOUND' });
  }
  const otherService = createMerchantSupportService({ ...options, merchant: { ...merchant, merchantId: 'merchant-b' } });
  await assert.rejects(otherService.getUpdates({ principal, conversationId: started.conversationId }), { code: 'CONVERSATION_NOT_FOUND' });
  remote.contactId = 999;
  await assert.rejects(service.getUpdates({ principal, conversationId: started.conversationId }), { code: 'CONVERSATION_BINDING_MISMATCH' });
});

test('public message output excludes staff notes and old cursor entries', async t => {
  const { start, service } = setup(t); const { conversationId } = await start();
  const result = await service.getUpdates({ principal, conversationId, cursor: '100' });
  assert.deepEqual(result.messages.map(x => x.content), ['Public answer']);
  assert.equal(result.messages[0].direction, 'merchant'); assert.equal(result.nextCursor, '102');
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  await assert.rejects(service.getUpdates({ principal, conversationId, cursor: '-1' }), { code: 'INVALID_CURSOR' });
});

test('reconnecting a merchant cannot expose an old thread even when remote numeric IDs collide', async t => {
  const { start, options, calls } = setup(t); const idempotencyKey = crypto.randomUUID(); const initial = await start({ idempotencyKey });
  const before = calls.length;
  for (const changed of [{ ...merchant, authorizationRef: 'replacement-authorization' }, { ...merchant, chatwoot: { ...merchant.chatwoot, baseUrl: 'https://other-chat.example' } }]) {
    const reconnected = createMerchantSupportService({ ...options, merchant: changed });
    await assert.rejects(reconnected.getUpdates({ principal, conversationId: initial.conversationId }), { code: 'CONVERSATION_NOT_FOUND' });
    await assert.rejects(reconnected.startConversation({ principal, merchantId: merchant.merchantId, message: 'Can you help?', idempotencyKey, consent }), { code: 'CONVERSATION_BINDING_MISMATCH' });
  }
  assert.equal(calls.length, before);
});

test('ambiguous upstream delivery remains uncertain and replay cannot duplicate a message', async t => {
  let sends = 0;
  const { start, service } = setup(t, { client: { async sendIncoming() { sends++; throw Object.assign(Error('connection closed'), { ambiguous: true }); } } });
  const { conversationId } = await start(); const input = { principal, conversationId, message: 'Question', idempotencyKey: crypto.randomUUID() };
  const sent = await service.sendMessage(input); assert.equal(sent.status, 'uncertain');
  assert.equal((await service.sendMessage(input)).operationId, sent.operationId); assert.equal(sends, 1);
  await assert.rejects(service.sendMessage({ ...input, idempotencyKey: crypto.randomUUID() }), { code: 'DELIVERY_REVIEW_REQUIRED' });
  const status = await service.operationStatus({ principal, operationId: sent.operationId });
  assert.equal(status.needsReconciliation, true); assert.equal(status.delivered, false);
});

test('concurrent same-key starts send only once while other caller receives pending receipt', async t => {
  let entered, release; const waiting = new Promise(r => entered = r); const hold = new Promise(r => release = r); let contacts = 0;
  const { start } = setup(t, { client: { async createContact() { contacts++; entered(); await hold; return { id: 40, sourceId: 'opaque-contact' }; } } });
  const idempotencyKey = crypto.randomUUID(); const first = start({ idempotencyKey }); await waiting;
  const second = await start({ idempotencyKey }); assert.equal(second.status, 'pending'); release();
  assert.equal((await first).status, 'delivered'); assert.equal(contacts, 1);
});

test('per-conversation writer fence rejects overlapping distinct sends', async t => {
  let entered, release; const waiting = new Promise(r => entered = r); const hold = new Promise(r => release = r);
  const { start, service } = setup(t, { client: { async sendIncoming() { entered(); await hold; return { id: 103 }; } } });
  const { conversationId } = await start(); const first = service.sendMessage({ principal, conversationId, message: 'One', idempotencyKey: crypto.randomUUID() }); await waiting;
  await assert.rejects(service.sendMessage({ principal, conversationId, message: 'Two', idempotencyKey: crypto.randomUUID() }), { code: 'DELIVERY_REVIEW_REQUIRED' });
  release(); assert.equal((await first).status, 'delivered');
});

test('expired write lease cannot be claimed again or completed by stale process', async t => {
  let at = 1000, entered, release; const waiting = new Promise(r => entered = r); const hold = new Promise(r => release = r); let sends = 0;
  const { start, service } = setup(t, { now: () => at, client: { async sendIncoming() { sends++; entered(); await hold; return { id: 103 }; } } });
  const { conversationId } = await start(); const input = { principal, conversationId, message: 'One', idempotencyKey: crypto.randomUUID() };
  const first = service.sendMessage(input); await waiting; at += 120001;
  assert.equal((await service.sendMessage(input)).status, 'uncertain'); release();
  assert.equal((await first).status, 'uncertain'); assert.equal(sends, 1);
});

test('human request persists bot suppression and reports queue status without claiming a human joined', async t => {
  const { start, service } = setup(t); const { conversationId } = await start();
  const handoff = await service.requestHuman({ principal, conversationId, idempotencyKey: crypto.randomUUID() });
  assert.equal(handoff.humanRequested, true); assert.equal(handoff.supportStatus, 'open');
  assert.equal(await service.canAutomate(30), false);
  assert.equal((await service.getUpdates({ principal, conversationId })).humanRequested, true);
});

test('expired start cannot resume and send its initial message after its receipt becomes uncertain', async t => {
  let at = 1000, entered, release; const waiting = new Promise(r => entered = r); const hold = new Promise(r => release = r);
  const { start, service, calls } = setup(t, { now: () => at, client: { async createContact() { entered(); await hold; return { id: 40, sourceId: 'opaque-contact' }; } } });
  const idempotencyKey = crypto.randomUUID(); const first = start({ idempotencyKey }); await waiting; at += 120001;
  const replay = await start({ idempotencyKey });
  const update = await service.getUpdates({ principal, conversationId: replay.conversationId });
  assert.equal(update.status, 'uncertain'); assert.equal(update.delivery[0].needsReconciliation, true);
  release(); assert.equal((await first).status, 'uncertain');
  assert.equal(calls.filter(x => x[0] === 'start').length, 0);
  assert.equal((await service.getUpdates({ principal, conversationId: replay.conversationId })).status, 'uncertain');
});

test('large message pages make cursor progress without dropping unreturned replies', async t => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ id: index + 101, private: false, message_type: 'outgoing', content: 'a'.repeat(4000) }));
  const { start, service } = setup(t, { client: { async listPublicMessages({ after }) { const page = rows.filter(x => x.id > after); return { messages: page, nextCursor: page.at(-1)?.id ?? after }; } } });
  const { conversationId } = await start(); let cursor = '0'; const seen = [];
  for (let page = 0; page < 15; page++) {
    const result = await service.getUpdates({ principal, conversationId, cursor });
    assert.ok(JSON.stringify(result).length < 96000); seen.push(...result.messages.map(x => x.id));
    assert.ok(Number(result.nextCursor) > Number(cursor)); cursor = result.nextCursor;
    if (!result.hasMore) break;
  }
  assert.deepEqual(seen, rows.map(x => String(x.id)));
});

test('uncertain delivery cannot prevent a buyer from stopping bot automation', async t => {
  const { start, service } = setup(t, { client: { async sendIncoming() { throw Object.assign(Error('timeout'), { ambiguous: true }); } } });
  const { conversationId } = await start();
  await service.sendMessage({ principal, conversationId, message: 'Question', idempotencyKey: crypto.randomUUID() });
  await assert.rejects(service.requestHuman({ principal, conversationId, idempotencyKey: crypto.randomUUID() }), { code: 'DELIVERY_REVIEW_REQUIRED' });
  assert.equal(await service.canAutomate(30), false);
  assert.equal((await service.getUpdates({ principal, conversationId })).humanRequested, true);
});

test('connection and approved knowledge are honest capabilities', async t => {
  const { DB } = testDatabase(t);
  const service = createMerchantSupportService({ db: DB, merchant, chatwoot: null, knowledge: null });
  await assert.rejects(service.startConversation({ principal, merchantId: merchant.merchantId, consent }), { code: 'SUPPORT_NOT_CONNECTED' });
  await assert.rejects(service.searchKnowledge({ merchantId: merchant.merchantId, query: 'price' }), { code: 'KNOWLEDGE_UNAVAILABLE' });
});
