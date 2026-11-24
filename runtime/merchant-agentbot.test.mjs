import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createD1MerchantAgentBotStore, createMerchantAgentBot, verifyChatwootWebhook } from './merchant-agentbot.mjs';
import { ChatwootClientError, createMerchantChatwootClient } from './merchant-chatwoot.mjs';

const merchant = { merchantId: 'merchant-one', siteSlug: 'merchant-one', name: 'Example Merchant', origin: 'https://merchant.example', privacyUrl: 'https://merchant.example/privacy', authorizationRef: 'authorization-fixture-v1', chatwoot: { baseUrl: 'https://support.example', accountId: 8, websiteInboxId: 20, apiInboxId: 21 } };
const secret = 'test-only-chatwoot-signing-secret-0123456789';
const scope = { merchantId: merchant.merchantId, siteSlug: merchant.siteSlug, chatwootOrigin: merchant.chatwoot.baseUrl, accountId: 8, inboxIds: [20, 21] };
const epoch = Date.parse('2026-11-24T12:00:00.000Z');
const encoder = new TextEncoder();
const incoming = overrides => ({ event: 'message_created', id: 101, account: { id: 8 }, inbox: { id: 20 }, message_type: 'incoming', private: false, content: 'What is the width?', created_at: '2026-11-24T12:00:00Z', sender: { id: 90, type: 'contact', email: 'private@example.test' }, conversation: { id: 35, account: { id: 8 }, inbox_id: 20, status: 'pending', meta: { sender: { id: 90 } } }, ...overrides });
const liveConversation = overrides => ({ id: 35, accountId: 8, inboxId: 20, contactId: 90, status: 'pending', assigneeType: 'AgentBot', assigneeId: 12, messages: [], ...overrides });
const knowledge = () => ({ approved: true, merchantId: merchant.merchantId, revision: 'approved-v1', facts: [{ id: 'fact-width', text: 'Published width is 150 cm.', sourceUrl: 'https://merchant.example/fabric' }] });
const candidate = overrides => ({ text: 'Published width is 150 cm.', confidence: 0.96, needsHuman: false, knowledgeRevision: 'approved-v1', evidenceIds: ['fact-width'], unsupportedCommitments: [], ...overrides });

function d1(sqlite) {
  return { prepare(sql) {
    let values = [];
    const statement = {
      bind(...args) { values = args; return statement; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) } }; },
    };
    return statement;
  } };
}

async function database(t) {
  const directory = await mkdtemp(join(tmpdir(), 'merchant-agentbot-'));
  const file = join(directory, 'agentbot.sqlite');
  let sqlite = new DatabaseSync(file);
  sqlite.exec(await readFile(new URL('./merchant-agentbot.schema.sql', import.meta.url), 'utf8'));
  t.after(async () => { sqlite.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get sqlite() { return sqlite; },
    get store() { return createD1MerchantAgentBotStore(d1(sqlite)); },
    reopen() { sqlite.close(); sqlite = new DatabaseSync(file); },
  };
}

async function signed(payload = incoming(), { now = epoch, signSecret = secret, body, delivery = crypto.randomUUID(), signatureOverride, timestampOverride } = {}) {
  const raw = body ?? JSON.stringify(payload);
  const timestamp = String(Math.floor(now / 1000));
  const key = await crypto.subtle.importKey('raw', encoder.encode(signSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${raw}`)));
  return new Request('https://merchant.example/api/merchant/chatwoot/webhook', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-Chatwoot-Timestamp': timestampOverride ?? timestamp,
    'X-Chatwoot-Signature': signatureOverride ?? `sha256=${Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('')}`, 'X-Chatwoot-Delivery': delivery,
  }, body: raw });
}

function runtime(store, overrides = {}) {
  const calls = { outgoing: [], handoffs: [], answers: [] };
  const client = {
    getConversation: async () => liveConversation(),
    sendAgentReply: async input => { if (input.beforeSend && !await input.beforeSend()) throw new ChatwootClientError('HUMAN_HAS_CONTROL'); calls.outgoing.push(input); return { id: 202 }; },
    requestHuman: async input => { calls.handoffs.push(input); return { status: 'open', handedOff: true }; },
    ...overrides.client,
  };
  const answer = async input => { calls.answers.push(input); return candidate(); };
  const bot = createMerchantAgentBot({ merchant, webhookSecret: secret, store, client, answer, loadKnowledge: async () => knowledge(), agentBotId: 12, now: () => epoch, ...overrides, client });
  return { bot, calls, client };
}

async function enqueue(bot, payload = incoming()) {
  const response = await bot.intake(await signed(payload));
  assert.equal(response.status, 202);
  return response.json();
}

test('webhook verification uses exact timestamp-dot-raw bytes and rejects stale, future, malformed or tampered signatures', async () => {
  const original = await signed();
  const bytes = new Uint8Array(await original.arrayBuffer());
  assert.equal(await verifyChatwootWebhook({ rawBody: bytes, headers: original.headers, secret, now: epoch }), true);
  assert.equal(await verifyChatwootWebhook({ rawBody: encoder.encode(new TextDecoder().decode(bytes) + ' '), headers: original.headers, secret, now: epoch }), false);
  assert.equal(await verifyChatwootWebhook({ rawBody: bytes, headers: original.headers, secret, now: epoch + 301_000 }), false);
  assert.equal(await verifyChatwootWebhook({ rawBody: bytes, headers: original.headers, secret, now: epoch - 301_000 }), false);
  const headers = new Headers(original.headers);
  headers.set('X-Chatwoot-Signature', 'sha256=ff');
  assert.equal(await verifyChatwootWebhook({ rawBody: bytes, headers, secret, now: epoch }), false);
  assert.equal(await verifyChatwootWebhook({ rawBody: bytes, headers: original.headers, secret: 'another-secret-012345678901234567890', now: epoch }), false);
});

test('intake acknowledges only durable writes, survives restart and dedupes message independently of delivery id', async t => {
  const db = await database(t);
  let { bot, calls } = runtime(db.store);
  const first = await enqueue(bot);
  assert.equal(first.duplicate, false);
  assert.equal(calls.outgoing.length + calls.handoffs.length + calls.answers.length, 0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS total FROM merchant_agentbot_jobs').get().total, 1);
  assert.equal(db.sqlite.prepare('SELECT payload_json FROM merchant_agentbot_jobs').get().payload_json.includes('private@example.test'), false);
  db.reopen();
  ({ bot } = runtime(db.store));
  const repeated = await enqueue(bot);
  assert.equal(repeated.jobId, first.jobId);
  assert.equal(repeated.duplicate, true);
  assert.equal((await bot.intake(await signed(incoming({ content: 'Changed content with reused message id' })))).status, 409);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS total FROM merchant_agentbot_jobs').get().total, 1);
});

test('invalid signature, tenant, inbox and contact identity cannot enqueue; outgoing/private events do not loop', async t => {
  const db = await database(t);
  const { bot } = runtime(db.store);
  assert.equal((await bot.intake(await signed(incoming(), { signatureOverride: 'sha256=' + 'a'.repeat(64) }))).status, 401);
  for (const [payload, status] of [
    [incoming({ account: { id: 9 } }), 403], [incoming({ inbox: { id: 99 } }), 403],
    [incoming({ sender: { id: 91, type: 'contact' } }), 400],
    [incoming({ conversation: { id: 35, account: { id: 9 }, inbox_id: 20, meta: { sender: { id: 90 } } } }), 400],
    [incoming({ private: true }), 200], [incoming({ message_type: 'outgoing' }), 200],
    [{ event: 'conversation_status_changed', account: { id: 8 }, inbox_id: 20, id: 35, status: 'open' }, 200],
  ]) assert.equal((await bot.intake(await signed(payload))).status, status);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS total FROM merchant_agentbot_jobs').get().total, 0);
});

test('unsupported body and method fail without writes; unavailable durable store returns Chatwoot-retryable 500', async t => {
  const db = await database(t);
  const { bot } = runtime(db.store);
  assert.equal((await bot.intake(new Request('https://merchant.example/webhook'))).status, 405);
  assert.equal((await bot.intake(new Request('https://merchant.example/webhook', { method: 'POST', body: 'wrong media' }))).status, 415);
  assert.equal((await bot.intake(await signed(null, { body: '{' }))).status, 400);
  assert.equal((await bot.intake(await signed(null, { body: 'x'.repeat(128 * 1024 + 1) }))).status, 413);
  const unavailable = runtime({ enqueue: async () => { throw new Error('database unavailable'); } });
  assert.equal((await unavailable.bot.intake(await signed())).status, 500);
  assert.equal(unavailable.calls.outgoing.length, 0);
});

test('approved grounded answer is sent once and persisted with evidence for reconciliation', async t => {
  const db = await database(t);
  const { bot, calls } = runtime(db.store);
  const receipt = await enqueue(bot);
  assert.deepEqual(await bot.processNext(), { status: 'delivered', jobId: receipt.jobId, messageId: 202 });
  assert.equal(calls.outgoing.length, 1);
  assert.equal(calls.outgoing[0].inReplyTo, 101);
  assert.equal(calls.outgoing[0].sourceId, `buyersite-agentbot:${receipt.jobId}`);
  const record = await db.store.get({ ...scope, jobId: receipt.jobId });
  assert.equal(record.knowledge_revision, 'approved-v1');
  assert.equal(record.sent_message_id, 202);
  assert.deepEqual(record.answer.evidenceIds, ['fact-width']);
  await enqueue(bot);
  assert.deepEqual(await bot.processNext(), { status: 'idle' });
  assert.equal(calls.outgoing.length, 1);
});

test('human ownership, changed bot and a newer incoming message stop generation', async t => {
  for (const [override, expected] of [
    [{ status: 'open' }, 'HUMAN_HAS_CONTROL'],
    [{ assigneeType: 'User', assigneeId: 5 }, 'HUMAN_HAS_CONTROL'],
    [{ assigneeId: 13 }, 'AGENTBOT_ASSIGNMENT_CHANGED'],
    [{ messages: [{ id: 102, message_type: 'incoming' }] }, 'MESSAGE_SUPERSEDED'],
  ]) {
    const db = await database(t);
    const { bot, calls } = runtime(db.store, { client: { getConversation: async () => liveConversation(override) } });
    await enqueue(bot);
    assert.equal((await bot.processNext()).reason, expected);
    assert.equal(calls.answers.length + calls.outgoing.length + calls.handoffs.length, 0);
  }
});

test('human takeover while generating is stopped by the final client preflight', async t => {
  const db = await database(t);
  const { bot, calls } = runtime(db.store, { client: { sendAgentReply: async () => { throw new ChatwootClientError('HUMAN_HAS_CONTROL'); } } });
  await enqueue(bot);
  assert.equal((await bot.processNext()).status, 'ignored');
  assert.equal(calls.outgoing.length, 0);
});

test('missing provider or approved knowledge and unsupported attachment all hand off without customer reply', async t => {
  const cases = [
    { options: { answer: undefined }, reason: 'PROVIDER_NOT_CONFIGURED' },
    { options: { loadKnowledge: async () => ({ ...knowledge(), approved: false }) }, reason: 'KNOWLEDGE_NOT_APPROVED' },
    { options: { loadKnowledge: async () => ({ ...knowledge(), merchantId: 'other' }) }, reason: 'KNOWLEDGE_NOT_APPROVED' },
    { options: {}, payload: incoming({ attachments: [{ id: 1, data_url: 'https://private.example/document' }] }), reason: 'UNSUPPORTED_MESSAGE' },
  ];
  for (const item of cases) {
    const db = await database(t);
    const { bot, calls } = runtime(db.store, item.options);
    await enqueue(bot, item.payload);
    const result = await bot.processNext();
    assert.equal(result.status, 'handed_off'); assert.equal(result.reason, item.reason);
    assert.equal(calls.handoffs.length, 1); assert.equal(calls.outgoing.length, 0);
  }
});

test('provider timeout is bounded and hands off', async t => {
  const db = await database(t);
  let signal;
  const { bot, calls } = runtime(db.store, { providerTimeoutMs: 10, answer: async input => { signal = input.signal; return new Promise(() => {}); } });
  await enqueue(bot);
  assert.equal((await bot.processNext()).reason, 'PROVIDER_TIMEOUT');
  assert.equal(signal.aborted, true);
  assert.equal(calls.handoffs.length, 1);
  assert.equal(calls.outgoing.length, 0);
});

test('low confidence, wrong evidence/version and unknown commercial promises all require a human', async t => {
  for (const [override, reason] of [
    [{ confidence: 0.79 }, 'LOW_CONFIDENCE'], [{ needsHuman: true }, 'LOW_CONFIDENCE'],
    [{ evidenceIds: ['invented-fact'] }, 'UNGROUNDED_ANSWER'], [{ knowledgeRevision: 'wrong' }, 'UNGROUNDED_ANSWER'],
    [{ unsupportedCommitments: ['delivery date'] }, 'UNSUPPORTED_COMMITMENT'],
    [{ text: 'The price is $12 and delivery is guaranteed tomorrow.' }, 'COMMERCIAL_REQUIRES_HUMAN'],
    [{ text: '价格12元，保证明天到货。' }, 'COMMERCIAL_REQUIRES_HUMAN'],
  ]) {
    const db = await database(t);
    const { bot, calls } = runtime(db.store, { answer: async () => candidate(override) });
    await enqueue(bot);
    assert.equal((await bot.processNext()).reason, reason);
    assert.equal(calls.outgoing.length, 0); assert.equal(calls.handoffs.length, 1);
  }
});

test('commercial facts need exact approved text and a current validity date', async t => {
  for (const [validUntil, text, expected] of [
    ['2026-11-25T00:00:00Z', 'Published price is USD 12 per metre.', 'delivered'],
    ['2026-11-23T00:00:00Z', 'Published price is USD 12 per metre.', 'handed_off'],
    ['2026-11-25T00:00:00Z', 'Published price is USD 12 per metre. Free shipping included.', 'handed_off'],
  ]) {
    const db = await database(t);
    const approved = { ...knowledge(), facts: [{ id: 'fact-price', text: 'Published price is USD 12 per metre.', sourceUrl: 'https://merchant.example/prices', commercialApproved: true, validUntil }] };
    const { bot } = runtime(db.store, { loadKnowledge: async () => approved, answer: async () => candidate({ text, evidenceIds: ['fact-price'] }) });
    await enqueue(bot, incoming({ content: 'What is the price?' }));
    assert.equal((await bot.processNext()).status, expected);
  }
});

test('atomic leases serialize one conversation while permitting another conversation', async t => {
  const db = await database(t);
  const { bot } = runtime(db.store);
  await enqueue(bot);
  await enqueue(bot, incoming({ id: 102 }));
  await enqueue(bot, incoming({ id: 103, conversation: { ...incoming().conversation, id: 36 } }));
  const [first, second, third] = await Promise.all([1, 2, 3].map(() => db.store.claim({ ...scope, now: epoch })));
  const claimed = [first, second, third].filter(Boolean);
  assert.equal(claimed.length, 2);
  assert.equal(new Set(claimed.map(row => row.conversation_id)).size, 2);
  assert.deepEqual(claimed.map(row => row.message_id).sort(), [101, 103]);
});

test('expired pre-send lease is reclaimable and stale worker cannot send', async t => {
  const db = await database(t);
  const { bot } = runtime(db.store);
  await enqueue(bot);
  const first = await db.store.claim({ ...scope, now: epoch, leaseMs: 1000 });
  const reclaimed = await db.store.claim({ ...scope, now: epoch + 1001, leaseMs: 1000 });
  assert.equal(reclaimed.id, first.id);
  assert.notEqual(reclaimed.lease_token, first.lease_token);
  assert.equal(await db.store.beginSend(first, candidate(), epoch + 1001), false);
  assert.equal(await db.store.beginSend(reclaimed, candidate(), epoch + 1001), true);
});

test('crashed sending lease becomes unknown and blocks further replies until external reconciliation', async t => {
  const db = await database(t);
  const { bot } = runtime(db.store);
  const receipt = await enqueue(bot);
  await enqueue(bot, incoming({ id: 102 }));
  const working = await db.store.claim({ ...scope, now: epoch, leaseMs: 1000 });
  assert.equal(await db.store.beginSend(working, candidate(), epoch), true);
  assert.equal(await db.store.claim({ ...scope, now: epoch + 1001 }), null);
  const unknown = await db.store.get({ ...scope, jobId: receipt.jobId });
  assert.equal(unknown.status, 'unknown');
  db.reopen();
  assert.equal(await db.store.claim({ ...scope, now: epoch + 20_000 }), null);
  assert.equal(await db.store.reconcile({ ...scope, merchantId: 'another-merchant', jobId: receipt.jobId, resolution: 'delivered', sentMessageId: 202, reason: 'Verified fixture receipt' }), false);
  assert.equal(await db.store.reconcile({ ...scope, jobId: receipt.jobId, resolution: 'delivered', sentMessageId: 202, reason: 'Verified Chatwoot message receipt', now: epoch + 20_000 }), true);
  assert.equal((await db.store.claim({ ...scope, now: epoch + 20_000 })).message_id, 102);
});

test('ambiguous network failure never blindly resends or re-runs the provider', async t => {
  const db = await database(t);
  let sends = 0;
  const { bot, calls } = runtime(db.store, { client: { sendAgentReply: async () => { sends++; throw new ChatwootClientError('CHATWOOT_TRANSPORT_ERROR', { ambiguous: true }); } } });
  const receipt = await enqueue(bot);
  assert.equal((await bot.processNext()).status, 'unknown');
  await enqueue(bot); await enqueue(bot, incoming({ id: 102 }));
  assert.equal((await bot.processNext()).status, 'idle');
  assert.equal(sends, 1); assert.equal(calls.answers.length, 1);
  assert.equal((await db.store.get({ ...scope, jobId: receipt.jobId })).answer.text, candidate().text);
});

test('handoff retries keep the action durable and never regenerate an answer', async t => {
  const db = await database(t);
  let time = epoch, attempts = 0, answers = 0;
  const { bot } = runtime(db.store, {
    now: () => time,
    answer: async () => { answers++; return candidate({ confidence: 0.2 }); },
    client: { requestHuman: async () => { attempts++; if (attempts === 1) throw new ChatwootClientError('CHATWOOT_TRANSPORT_ERROR', { ambiguous: true }); return { status: 'open' }; } },
  });
  const receipt = await enqueue(bot);
  assert.equal((await bot.processNext()).status, 'retry');
  assert.equal((await db.store.get({ ...scope, jobId: receipt.jobId })).action, 'handoff');
  time += 10_000;
  assert.equal((await bot.processNext()).status, 'handed_off');
  assert.equal(attempts, 2); assert.equal(answers, 1);
});

test('local durable human flag blocks before generation and after generation, including failed control reads', async t => {
  for (const variant of ['before', 'after', 'error']) {
    const db = await database(t);
    let allowed = variant !== 'before';
    let answers = 0;
    const { bot, calls } = runtime(db.store, {
      canAutomate: async () => { if (variant === 'error') throw new Error('control store failed'); return allowed; },
      answer: async () => { answers++; allowed = false; return candidate(); },
    });
    await enqueue(bot);
    const result = await bot.processNext();
    assert.equal(result.status, 'handed_off');
    assert.equal(result.reason, 'HUMAN_REQUESTED');
    assert.equal(answers, variant === 'after' ? 1 : 0);
    assert.equal(calls.outgoing.length, 0);
  }
});

test('last pre-send callback requires both current automation permission and a valid send lease', async t => {
  const db = await database(t);
  let time = epoch;
  let lastGuard;
  const { bot } = runtime(db.store, { now: () => time, client: {
    sendAgentReply: async input => { lastGuard = input.beforeSend; assert.equal(await lastGuard(), true); time += 120_001; assert.equal(await lastGuard(), false); throw new ChatwootClientError('HUMAN_HAS_CONTROL'); },
  } });
  await enqueue(bot);
  assert.equal((await bot.processNext()).status, 'ignored');
  assert.equal(typeof lastGuard, 'function');
});

test('same merchant across editions, instances, accounts or inboxes cannot claim, reap, read or reconcile foreign jobs', async t => {
  const db = await database(t);
  const { bot } = runtime(db.store);
  const own = await enqueue(bot);
  const foreignIds = [];
  for (const [siteSlug, accountId, inboxId, baseUrl] of [['second-edition', 8, 20, merchant.chatwoot.baseUrl], [merchant.siteSlug, 9, 20, merchant.chatwoot.baseUrl], [merchant.siteSlug, 8, 22, merchant.chatwoot.baseUrl], [merchant.siteSlug, 8, 20, 'https://support-new.example']]) {
    const foreignMerchant = { ...merchant, siteSlug, chatwoot: { ...merchant.chatwoot, accountId, websiteInboxId: inboxId, baseUrl } };
    const foreign = runtime(db.store, { merchant: foreignMerchant });
    const payload = incoming({ account: { id: accountId }, inbox: { id: inboxId }, conversation: { ...incoming().conversation, account: { id: accountId }, inbox_id: inboxId } });
    foreignIds.push((await enqueue(foreign.bot, payload)).jobId);
  }
  const claimed = await db.store.claim({ ...scope, now: epoch });
  assert.equal(claimed.id, own.jobId);
  assert.equal(await db.store.beginSend({ ...claimed, site_slug: 'second-edition' }, candidate(), epoch), false);
  assert.equal(await db.store.finish(claimed, { status: 'ignored', reason: 'TEST_COMPLETE', now: epoch }), true);
  for (const id of foreignIds) db.sqlite.prepare("UPDATE merchant_agentbot_jobs SET status='sending',lease_until=?,lease_token='foreign-lease' WHERE id=?").run(epoch - 1, id);
  assert.equal(await db.store.claim({ ...scope, now: epoch + 10_000 }), null);
  for (const id of foreignIds) {
    assert.equal(db.sqlite.prepare('SELECT status FROM merchant_agentbot_jobs WHERE id=?').get(id).status, 'sending');
    assert.equal(await db.store.get({ ...scope, jobId: id }), null);
    db.sqlite.prepare("UPDATE merchant_agentbot_jobs SET status='unknown' WHERE id=?").run(id);
    assert.equal(await db.store.reconcile({ ...scope, jobId: id, resolution: 'ignored', reason: 'Wrong scope', now: epoch }), false);
  }
});

test('stale durable jobs hand off after downtime without trusting webhook created_at or calling the model', async t => {
  const db = await database(t);
  const received = runtime(db.store);
  await enqueue(received.bot, incoming({ created_at: '2099-01-01T00:00:00Z' }));
  db.reopen();
  const resumed = runtime(db.store, { now: () => epoch + 86_400_001 });
  const result = await resumed.bot.processNext();
  assert.equal(result.status, 'handed_off');
  assert.equal(result.reason, 'JOB_EXPIRED');
  assert.equal(resumed.calls.answers.length + resumed.calls.outgoing.length, 0);
  assert.equal(resumed.calls.handoffs.length, 1);
});

test('concurrent approved-knowledge activation vetoes the actual outgoing POST and hands off', async t => {
  const db = await database(t);
  let active = knowledge(), started, release, outgoingPosts = 0, handoffs = 0;
  const generating = new Promise(resolve => { started = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const realClient = createMerchantChatwootClient({ merchant, apiToken: 'service-token-fixture-123456789', agentBotToken: 'agentbot-token-fixture-123456789', fetchFn: async (url, options) => {
    if (options.method === 'GET') return Response.json({ id: 35, account_id: 8, inbox_id: 20, status: 'pending', meta: { sender: { id: 90 }, assignee_type: 'AgentBot', assignee: { id: 12 } }, messages: [] });
    if (url.endsWith('/toggle_status')) { handoffs++; return Response.json({ payload: { current_status: 'open', conversation_id: 35 } }); }
    outgoingPosts++;
    return Response.json({ id: 202, message_type: 1, private: false, content: 'Width is 150 cm.' });
  } });
  const { bot } = runtime(db.store, { client: realClient, loadKnowledge: async () => active,
    answer: async () => { started(); await paused; return candidate(); } });
  const receipt = await enqueue(bot);
  const processing = bot.processNext();
  await generating;
  active = { ...knowledge(), revision: 'approved-v2' };
  release();
  const result = await processing;
  assert.equal(result.status, 'handed_off');
  assert.equal(result.reason, 'KNOWLEDGE_CHANGED');
  assert.equal(outgoingPosts, 0);
  assert.equal(handoffs, 1);
  assert.equal((await db.store.get({ ...scope, jobId: receipt.jobId })).status, 'handed_off');
});
