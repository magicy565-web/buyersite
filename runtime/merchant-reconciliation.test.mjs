import assert from 'node:assert/strict';
import test from 'node:test';
import { createMerchantReconciliation } from './merchant-reconciliation.mjs';
import { createMerchantSupportService } from './merchant-support-service.mjs';
import { CONSENT_VERSION, digest, principalHash } from './merchant-common.mjs';
import { testDatabase } from './merchant-test-helpers.mjs';

const NOW = 1_800_000_000_000;
const merchant = { merchantId: 'merchant-a', siteSlug: 'edition-a', origin: 'https://shop.example.test', authorizationRef: 'owner-approval-1',
  chatwoot: { baseUrl: 'https://support.example.test', accountId: 11, websiteInboxId: 21, apiInboxId: 22 } };
const principal = { issuer: 'https://identity.example.test', subject: 'customer-a', scopes: ['merchant:support:read', 'merchant:support:write'] };
const content = 'Please confirm the published return policy.';
const owner = { actorId: 'owner-a' };

async function setup(t, { kind = 'start', ...overrides } = {}) {
  const { sqlite, DB } = testDatabase(t, ['merchant-support.schema.sql', 'merchant-reconciliation.schema.sql']);
  const operationId = crypto.randomUUID(); const threadId = crypto.randomUUID(); const key = crypto.randomUUID();
  const binding = await digest(JSON.stringify({ siteSlug: merchant.siteSlug, merchantId: merchant.merchantId, origin: merchant.origin,
    authorizationRef: merchant.authorizationRef, chatwoot: merchant.chatwoot }));
  const who = await principalHash(principal);
  const payload = kind === 'start' ? { content, consent: CONSENT_VERSION } : kind === 'message' ? { content } : {};
  const payloadHash = await digest(JSON.stringify({ kind, conversationId: kind === 'start' ? null : threadId, payload }));
  sqlite.prepare(`INSERT INTO merchant_support_threads
    (site_slug, merchant_id, id, principal_hash, binding_hash, contact_id, contact_source_id, conversation_id, state,
     handoff_requested, consent_version, consent_at, created_at, updated_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 40, 'contact-source', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(merchant.siteSlug, merchant.merchantId, threadId, who, binding, kind === 'start' ? null : 30,
      kind === 'start' ? 'uncertain' : 'active', kind === 'human' ? 1 : 0, CONSENT_VERSION, NOW - 120_000, NOW - 120_000, NOW - 1_000, NOW + 86_400_000);
  sqlite.prepare(`INSERT INTO merchant_support_operations
    (site_slug, merchant_id, id, thread_id, principal_hash, binding_hash, key_hash, kind, payload_hash, state, lease_token, lease_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'uncertain', NULL, ?, ?, ?)`)
    .run(merchant.siteSlug, merchant.merchantId, operationId, threadId, who, binding, await digest(key), kind, payloadHash, NOW - 1000, NOW - 120_000, NOW - 1000);
  const calls = [];
  const remote = { id: 30, accountId: 11, inboxId: 22, contactId: 40, status: kind === 'human' ? 'open' : 'pending' };
  const messages = [{ id: 101, private: false, message_type: 'incoming', content, createdAt: new Date(NOW - 110_000).toISOString() }];
  const client = {
    async getConversation(input) { calls.push(['getConversation', input]); return { ...remote }; },
    async listPublicMessages(input) { calls.push(['listPublicMessages', input]); return { messages, nextCursor: 101 }; },
    async createContact() { throw Error('Recovery must not create a contact'); },
    async createConversation() { throw Error('Recovery must not create a conversation'); },
    async sendIncoming() { throw Error('Recovery must not resend a message'); },
    async requestHuman() { throw Error('Recovery must not request another handoff'); },
  };
  const options = { db: DB, merchant, chatwoot: client, now: () => NOW, ...overrides };
  const reconcile = createMerchantReconciliation(options);
  const input = { operationId, expectedUpdatedAt: NOW - 1000, resolution: 'delivered',
    ...(kind === 'start' ? { externalConversationId: 30 } : {}), ...(kind === 'human' ? {} : { externalMessageId: 101 }),
    evidenceRef: 'review-cases/support-123', evidenceHash: 'a'.repeat(64) };
  const operation = () => sqlite.prepare('SELECT * FROM merchant_support_operations WHERE id = ?').get(operationId);
  const thread = () => sqlite.prepare('SELECT * FROM merchant_support_threads WHERE id = ?').get(threadId);
  const audits = () => sqlite.prepare('SELECT * FROM merchant_support_reconciliations').all();
  const absence = () => { const { externalConversationId: _conversation, externalMessageId: _message, ...rest } = input; return { ...rest, resolution: 'not_delivered' }; };
  return { sqlite, DB, reconcile, input, absence, options, calls, remote, messages, client, operation, thread, audits, key, threadId, operationId };
}

test('verifies a start receipt against provider ownership, exact incoming message and original payload', async t => {
  const fixture = await setup(t);
  const result = await fixture.reconcile(fixture.input, owner);
  assert.equal(result.status, 'delivered'); assert.equal(result.verification, 'provider_verified');
  assert.equal(result.externalConversationId, 30); assert.equal(result.externalMessageId, 101);
  assert.equal(fixture.operation().state, 'delivered'); assert.equal(fixture.thread().state, 'active');
  assert.equal(fixture.thread().conversation_id, 30);
  assert.deepEqual(fixture.calls, [
    ['getConversation', { conversationId: 30, contactId: 40 }],
    ['listPublicMessages', { conversationId: 30, after: 100, contactId: 40 }],
  ]);
  const [audit] = fixture.audits();
  assert.equal(audit.actor_id, owner.actorId); assert.equal(audit.evidence_hash, fixture.input.evidenceHash);
  assert.equal(audit.resolution, 'delivered'); assert.equal(audit.verification, 'provider_verified');
  assert.equal(audit.previous_updated_at, fixture.input.expectedUpdatedAt);
  const customerReceipt = JSON.parse(fixture.operation().result_json);
  assert.equal(customerReceipt.reconciliationSource, 'provider_verified');
  assert.equal(customerReceipt.messageId, '101');
  assert.doesNotMatch(fixture.operation().result_json, /owner-a|review-cases|Please confirm/);
  assert.equal(JSON.stringify(audit).includes(content), false);
  assert.throws(() => fixture.sqlite.prepare('UPDATE merchant_support_reconciliations SET evidence_ref = ?').run('changed'), /immutable/);
  assert.throws(() => fixture.sqlite.prepare('DELETE FROM merchant_support_reconciliations').run(), /immutable/);
  await assert.rejects(fixture.reconcile(fixture.input, owner), { code: 'RECONCILIATION_STALE' });
  assert.equal(fixture.audits().length, 1);
});

test('message recovery uses the stored conversation and preserves the thread and human preference', async t => {
  const fixture = await setup(t, { kind: 'message' });
  fixture.sqlite.prepare('UPDATE merchant_support_threads SET handoff_requested = 1').run();
  assert.equal((await fixture.reconcile(fixture.input, owner)).status, 'delivered');
  assert.equal(fixture.thread().state, 'active'); assert.equal(fixture.thread().handoff_requested, 1);
  assert.equal(fixture.audits()[0].external_conversation_id, 30);
});

test('human recovery verifies open remote status without sending anything or clearing suppression', async t => {
  const fixture = await setup(t, { kind: 'human' });
  const result = await fixture.reconcile(fixture.input, owner);
  assert.equal(result.verification, 'provider_verified'); assert.equal(result.delivered, true);
  assert.equal(fixture.thread().handoff_requested, 1);
  assert.deepEqual(fixture.calls.map(item => item[0]), ['getConversation']);
  assert.equal(fixture.audits()[0].external_message_id, null);
  assert.equal(JSON.parse(fixture.operation().result_json).humanRequested, true);
});

test('not-delivered is an explicit owner assertion and performs no provider access', async t => {
  const fixture = await setup(t, { chatwoot: null });
  fixture.sqlite.prepare('UPDATE merchant_support_threads SET handoff_requested = 1').run();
  const result = await fixture.reconcile(fixture.absence(), owner);
  assert.equal(result.status, 'failed'); assert.equal(result.delivered, false); assert.equal(result.verification, 'owner_recorded');
  assert.equal(fixture.operation().state, 'failed'); assert.equal(fixture.thread().state, 'failed');
  assert.equal(fixture.thread().handoff_requested, 1); assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.audits()[0].external_conversation_id, null);
  assert.equal(JSON.parse(fixture.operation().result_json).reconciliationSource, 'owner_recorded');
});

test('owner absence recovery also closes an operation that crashed before thread insertion', async t => {
  const fixture = await setup(t);
  fixture.sqlite.prepare('DELETE FROM merchant_support_threads').run();
  assert.equal((await fixture.reconcile(fixture.absence(), owner)).status, 'failed');
  assert.equal(fixture.audits().length, 1); assert.deepEqual(fixture.calls, []);
});

test('clears an uncertain writer fence without resending, and old request keys still replay failed', async t => {
  const fixture = await setup(t, { kind: 'message' });
  await fixture.reconcile(fixture.absence(), owner);
  let sends = 0;
  fixture.client.sendIncoming = async () => { sends++; return { id: 102 }; };
  const service = createMerchantSupportService({ db: fixture.DB, merchant, chatwoot: fixture.client, now: () => NOW });
  const previous = await service.sendMessage({ principal, merchantId: merchant.merchantId, conversationId: fixture.threadId, message: content, idempotencyKey: fixture.key });
  assert.equal(previous.status, 'failed'); assert.equal(sends, 0);
  const next = await service.sendMessage({ principal, merchantId: merchant.merchantId, conversationId: fixture.threadId, message: 'A separately requested new question.', idempotencyKey: crypto.randomUUID() });
  assert.equal(next.status, 'delivered'); assert.equal(sends, 1);
});

test('rejects provider ownership mismatches before reading messages', async t => {
  for (const [name, changes] of Object.entries({ account: { accountId: 99 }, inbox: { inboxId: 21 }, contact: { contactId: 999 }, conversation: { id: 31 } })) {
    await t.test(name, async sub => {
      const fixture = await setup(sub); Object.assign(fixture.remote, changes);
      await assert.rejects(fixture.reconcile(fixture.input, owner), { code: 'RECONCILIATION_EVIDENCE_UNVERIFIED' });
      assert.equal(fixture.operation().state, 'uncertain'); assert.equal(fixture.audits().length, 0);
      assert.equal(fixture.calls.length, 1);
    });
  }
});

test('rejects incorrect text, private/outgoing messages, missing exact IDs and invalid timestamps', async t => {
  const changes = {
    'wrong content': { content: 'A different customer message.' }, 'private note': { private: true }, 'outgoing reply': { message_type: 'outgoing' },
    'wrong message ID': { id: 102 }, 'stale evidence': { createdAt: new Date(NOW - 150_001).toISOString() },
    'future evidence': { createdAt: new Date(NOW + 30_001).toISOString() }, 'unparseable timestamp': { createdAt: 'unknown' },
    'missing timestamp': { createdAt: undefined },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async sub => {
    const fixture = await setup(sub); Object.assign(fixture.messages[0], change);
    await assert.rejects(fixture.reconcile(fixture.input, owner), { code: 'RECONCILIATION_EVIDENCE_UNVERIFIED' });
    assert.equal(fixture.audits().length, 0); assert.equal(fixture.thread().state, 'uncertain');
  });
  await t.test('duplicate message IDs', async sub => {
    const fixture = await setup(sub); fixture.messages.push({ ...fixture.messages[0] });
    await assert.rejects(fixture.reconcile(fixture.input, owner), { code: 'RECONCILIATION_EVIDENCE_UNVERIFIED' });
  });
});

test('cannot invent a stored contact, change consent, or select another conversation', async t => {
  for (const sql of ['UPDATE merchant_support_threads SET contact_id = NULL', "UPDATE merchant_support_threads SET consent_version = 'unapproved'", 'UPDATE merchant_support_threads SET conversation_id = 31']) {
    await t.test(sql, async sub => {
      const fixture = await setup(sub); fixture.sqlite.exec(sql);
      await assert.rejects(fixture.reconcile(fixture.input, owner), { code: 'RECONCILIATION_EVIDENCE_UNVERIFIED' });
      assert.equal(fixture.audits().length, 0);
    });
  }
  const message = await setup(t, { kind: 'message' });
  await assert.rejects(message.reconcile({ ...message.input, externalConversationId: 31 }, owner), { code: 'RECONCILIATION_EVIDENCE_UNVERIFIED' });
  assert.equal(message.calls.length, 0);
  const human = await setup(t, { kind: 'human' }); human.remote.status = 'pending';
  await assert.rejects(human.reconcile(human.input, owner), { code: 'RECONCILIATION_EVIDENCE_UNVERIFIED' });
  assert.equal(human.thread().handoff_requested, 1);
});

test('rejects foreign merchants, old instance bindings and another principal thread association', async t => {
  const fixture = await setup(t);
  for (const changed of [{ ...merchant, merchantId: 'merchant-b' }, { ...merchant, authorizationRef: 'new-approval' },
    { ...merchant, chatwoot: { ...merchant.chatwoot, baseUrl: 'https://new-instance.example.test' } }]) {
    const reconcile = createMerchantReconciliation({ ...fixture.options, merchant: changed });
    await assert.rejects(reconcile(fixture.input, owner), { code: 'OPERATION_NOT_FOUND' });
  }
  fixture.sqlite.prepare('UPDATE merchant_support_threads SET principal_hash = ?').run('foreign-customer');
  await assert.rejects(fixture.reconcile(fixture.input, owner), { code: 'RECONCILIATION_EVIDENCE_UNVERIFIED' });
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.audits().length, 0);
});

test('rejects stale receipts before provider calls and races after provider verification', async t => {
  const fixture = await setup(t);
  await assert.rejects(fixture.reconcile({ ...fixture.input, expectedUpdatedAt: NOW - 2000 }, owner), { code: 'RECONCILIATION_STALE' });
  assert.equal(fixture.calls.length, 0);
  fixture.client.listPublicMessages = async () => {
    fixture.sqlite.prepare('UPDATE merchant_support_operations SET updated_at = ?').run(NOW - 500);
    return { messages: fixture.messages };
  };
  await assert.rejects(fixture.reconcile(fixture.input, owner), { code: 'RECONCILIATION_STALE' });
  assert.equal(fixture.audits().length, 0); assert.equal(fixture.operation().state, 'uncertain'); assert.equal(fixture.thread().state, 'uncertain');
});

test('thread changes also prevent a stale recovery from activating a conversation', async t => {
  const fixture = await setup(t);
  fixture.client.listPublicMessages = async () => {
    fixture.sqlite.prepare('UPDATE merchant_support_threads SET updated_at = ?, handoff_requested = 1').run(NOW - 500);
    return { messages: fixture.messages };
  };
  await assert.rejects(fixture.reconcile(fixture.input, owner), { code: 'RECONCILIATION_STALE' });
  assert.equal(fixture.audits().length, 0); assert.equal(fixture.thread().handoff_requested, 1); assert.equal(fixture.thread().state, 'uncertain');
});

test('a failed activation rolls back the receipt and audit in the same D1 batch', async t => {
  const fixture = await setup(t);
  fixture.sqlite.exec("CREATE TRIGGER fail_activation BEFORE UPDATE ON merchant_support_threads WHEN NEW.state = 'active' BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;");
  await assert.rejects(fixture.reconcile(fixture.input, owner), { code: 'RECONCILIATION_STORAGE_UNAVAILABLE' });
  assert.equal(fixture.operation().state, 'uncertain'); assert.equal(fixture.thread().state, 'uncertain'); assert.equal(fixture.audits().length, 0);
});

test('provider outages do not mark delivery and do not expose provider error text', async t => {
  const fixture = await setup(t);
  fixture.client.getConversation = async () => { throw Error('secret provider token and customer data'); };
  await assert.rejects(fixture.reconcile(fixture.input, owner), error => {
    assert.equal(error.code, 'RECONCILIATION_PROVIDER_UNAVAILABLE'); assert.doesNotMatch(error.message, /secret|customer data/); return true;
  });
  assert.equal(fixture.operation().state, 'uncertain'); assert.equal(fixture.audits().length, 0);
});

test('requires exact input fields, owner identity, valid evidence references and hashes', async t => {
  const fixture = await setup(t);
  for (const patch of [{ operationId: 'not-a-uuid' }, { expectedUpdatedAt: -1 }, { expectedUpdatedAt: '1800000000000' },
    { resolution: 'retry' }, { evidenceHash: 'bad' }, { evidenceHash: 'A'.repeat(64) }, { evidenceRef: 123 }, { evidenceRef: null }, { evidenceRef: 'https://private.example.test/evidence' },
    { evidenceRef: 'inline secret\nbody' }, { externalConversationId: -1 }, { externalMessageId: '1e3' }, { externalMessageId: Number.MAX_SAFE_INTEGER + 1 },
    { claimed: true }, { actorId: 'caller-forged-owner' }]) {
    await assert.rejects(fixture.reconcile({ ...fixture.input, ...patch }, owner), { code: 'INVALID_RECONCILIATION' });
  }
  for (const actorId of [undefined, '', 'owner\nforged']) await assert.rejects(fixture.reconcile(fixture.input, { actorId }), { code: 'INVALID_RECONCILIATION' });
  await assert.rejects(fixture.reconcile({ ...fixture.absence(), externalMessageId: 101 }, owner), { code: 'INVALID_RECONCILIATION' });
  assert.equal(fixture.calls.length, 0); assert.equal(fixture.audits().length, 0);
});
