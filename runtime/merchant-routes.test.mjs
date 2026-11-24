import test from 'node:test';
import assert from 'node:assert/strict';
import { createMerchantRoutes } from './merchant-routes.mjs';
import { MerchantOAuthError } from './merchant-oauth.mjs';
import { MERCHANT_MCP_PROTOCOL_VERSION } from './merchant-mcp.mjs';
import { testDatabase } from './merchant-test-helpers.mjs';

const ADMIN = '/api/buyer/admin/merchant-support';
const ADMIN_TOKEN = 'test-owner-token-that-exceeds-thirty-two-characters';
const CHATWOOT_TOKEN = 'test-chatwoot-token-for-fake-fetch-only';
const NOW = Date.parse('2026-11-24T01:00:00.000Z');
const ISSUER = 'https://identity.example';
const READ = 'merchant:support:read', WRITE = 'merchant:support:write';
const CONSENT = { accepted: true, version: 'merchant-support-v1' };
const MERCHANT = { merchantId: 'merchant-one', siteSlug: 'material-notes', name: 'Example Merchant',
  origin: 'https://shop.example', privacyUrl: 'https://shop.example/privacy', authorizationRef: 'merchant-owner-grant',
  chatwoot: { baseUrl: 'https://chat.example', accountId: 11, websiteInboxId: 21, apiInboxId: 22 } };
const fact = (overrides = {}) => ({ evidence_id: 'fabric-width', merchant_id: MERCHANT.merchantId, kind: 'product',
  claim: 'Published fabric width', value: '150 cm', source_url: 'https://shop.example/fabric#width',
  captured_at: '2026-11-20T00:00:00Z', valid_until: null, status: 'merchant-confirmed', audience: 'public', publication_permission: 'approved', ...overrides });
const event = (kind, expectedRevision, overrides = {}) => ({ event_id: crypto.randomUUID(), kind, expectedRevision,
  artifact_ref: 'redacted:business-hub-evidence', artifact_sha256: 'b'.repeat(64), observed_at: '2026-11-23T00:00:00Z',
  official_url: 'https://chatgpt.com/business-hub', ...overrides });
const jsonResponse = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });

function setup(t, { publication = 'public' } = {}) {
  const { DB, sqlite } = testDatabase(t, ['merchant-support.schema.sql', 'merchant-knowledge.schema.sql', 'merchant-agentbot.schema.sql', 'merchant-reconciliation.schema.sql']);
  const calls = [], verifications = [];
  let at = NOW, nextMessage = 200;
  const remote = { id: 30, account_id: 11, inbox_id: 22, status: 'pending', meta: { sender: { id: 40 } }, messages: [] };
  const fetchFn = async (input, init) => {
    const url = new URL(input), body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url: url.href, method: init.method, body });
    assert.equal(url.origin, 'https://chat.example', 'All external requests must stay in the fake Chatwoot transport.');
    assert.equal(init.headers.Authorization, `Bearer ${CHATWOOT_TOKEN}`);
    assert.equal(init.redirect, 'error');
    const path = url.pathname;
    if (init.method === 'POST' && path === '/api/v1/accounts/11/contacts') {
      assert.equal(body.inbox_id, 22);
      return jsonResponse({ payload: { contact: { id: 40, identifier: body.identifier }, contact_inbox: { inbox: { id: 22 }, source_id: 'opaque-contact-40' } } });
    }
    if (init.method === 'POST' && path === '/api/v1/accounts/11/conversations') {
      assert.equal(body.inbox_id, 22); assert.equal(body.contact_id, 40);
      assert.equal(body.message.message_type, 'incoming'); assert.equal(body.message.private, false);
      return jsonResponse(remote);
    }
    if (init.method === 'GET' && path === '/api/v1/accounts/11/conversations/30') return jsonResponse(remote);
    if (init.method === 'GET' && path === '/api/v1/accounts/11/conversations/30/messages') {
      assert.equal(url.searchParams.get('filter_internal_messages'), 'true');
      return jsonResponse({ payload: [
        { id: 101, content: 'Please confirm the published width.', private: false, message_type: 0, created_at: 1_795_479_600 },
        { id: 102, content: 'The published width is 150 cm.', private: false, message_type: 1, created_at: 1_795_479_620 },
        { id: 103, content: 'PRIVATE STAFF NOTE', private: true, message_type: 1 },
        { id: 104, content: 'INTERNAL STATUS ACTIVITY', private: false, message_type: 2 },
      ] });
    }
    if (init.method === 'POST' && path === '/api/v1/accounts/11/conversations/30/messages') {
      return jsonResponse({ id: ++nextMessage, content: body.content, message_type: 'incoming', private: false, conversation_id: 30, inbox_id: 22 });
    }
    if (init.method === 'POST' && path === '/api/v1/accounts/11/conversations/30/toggle_status') {
      remote.status = 'open';
      return jsonResponse({ payload: { current_status: 'open', conversation_id: 30 } });
    }
    throw new Error('Unexpected fake Chatwoot route.');
  };
  const verifyAccessToken = async (token, scopes) => {
    verifications.push({ token, scopes });
    if (!['buyer-a', 'buyer-b', 'read-only'].includes(token)) throw new MerchantOAuthError();
    const permitted = token === 'read-only' ? [READ] : [READ, WRITE];
    if (scopes.some(scope => !permitted.includes(scope))) throw new MerchantOAuthError('insufficient_scope', 403);
    return { issuer: ISSUER, subject: token, scopes: permitted };
  };
  const config = { siteSlug: MERCHANT.siteSlug, origin: MERCHANT.origin, publication };
  const env = { DB, BUYERSITE_ADMIN_TOKEN: ADMIN_TOKEN, BUYERSITE_MERCHANT_OWNER_ID: 'owner-one', BUYERSITE_MERCHANT_SUPPORT_ENABLED: 'true',
    BUYERSITE_MERCHANT_CONFIG: JSON.stringify({ version: 1, authorized: true, ...MERCHANT }), BUYERSITE_CHATWOOT_API_TOKEN: CHATWOOT_TOKEN,
    BUYERSITE_MERCHANT_OAUTH_ISSUER: ISSUER, BUYERSITE_MERCHANT_OAUTH_JWKS_URI: `${ISSUER}/jwks` };
  const makeRoutes = newConfig => createMerchantRoutes(newConfig, { fetchFn, verifyAccessToken, now: () => at });
  const routes = makeRoutes(config);
  async function hit(path, { method = 'GET', body, token = null, headers = {}, requestOrigin = MERCHANT.origin, server = routes, environment = env } = {}) {
    const response = await server.fetch(new Request(requestOrigin + path, { method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), environment);
    return { response, body: response ? await response.json() : null };
  }
  const admin = (path = '', options = {}) => hit(ADMIN + path, { token: ADMIN_TOKEN, ...options });
  const mcp = (name, args, { token = null, ...options } = {}) => hit('/mcp', {
    method: 'POST', token, headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': MERCHANT_MCP_PROTOCOL_VERSION },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ...options,
  });
  return { DB, sqlite, routes, makeRoutes, config, env, calls, verifications, remote, hit, admin, mcp, advance: milliseconds => { at += milliseconds; } };
}

async function publish(harness, facts = [fact()], expectedRevision = null) {
  const saved = await harness.admin('/knowledge', { method: 'POST', body: { facts } });
  assert.equal(saved.response.status, 201, JSON.stringify(saved.body));
  const active = await harness.admin('/knowledge/activate', { method: 'POST', body: { revision: saved.body.revision, expectedRevision } });
  assert.equal(active.response.status, 200, JSON.stringify(active.body));
  return saved.body.revision;
}

test('owner routes use the existing admin token and require the server owner identity for writes', async t => {
  const h = setup(t);
  for (const token of [null, 'buyer-a', 'wrong-owner-token-that-exceeds-thirty-two-characters']) {
    const result = await h.admin('', { token });
    assert.equal(result.response.status, 401); assert.equal(result.body.error.code, 'OWNER_AUTH_REQUIRED');
  }
  const status = await h.admin();
  assert.equal(status.response.status, 200); assert.equal(status.body.merchant.merchant_id, MERCHANT.merchantId);
  assert.equal(status.body.onboarding.status_origin, 'owner_recorded'); assert.equal(status.body.liveConnectionVerified, false);
  for (const secret of [ADMIN_TOKEN, CHATWOOT_TOKEN, MERCHANT.authorizationRef]) assert.equal(JSON.stringify(status.body).includes(secret), false);
  const missingIdentity = await h.admin('/knowledge', { method: 'POST', body: { facts: [fact()] }, environment: { ...h.env, BUYERSITE_MERCHANT_OWNER_ID: undefined } });
  assert.equal(missingIdentity.response.status, 400);
  const forged = await h.admin('/knowledge', { method: 'POST', body: { facts: [fact()], actorId: 'spoofed-owner' } });
  assert.equal(forged.response.status, 400);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS count FROM merchant_knowledge_versions').get().count, 0);
  assert.equal(h.calls.length, 0);
});

test('owner publication CAS feeds anonymous MCP search with only current approved facts and exact citations', async t => {
  const h = setup(t);
  const revision = await publish(h, [fact({ internal_note: 'SECRET OWNER NOTE' }),
    fact({ evidence_id: 'internal-width', audience: 'internal', value: 'SECRET WIDTH' }),
    fact({ evidence_id: 'price', kind: 'price', claim: 'Current price', value: '12.50 USD', valid_until: '2026-11-24T01:01:00Z' })]);
  const lookup = await h.mcp('search_merchant_knowledge', { merchant_id: MERCHANT.merchantId, query: 'width' });
  assert.equal(lookup.response.status, 200);
  const knowledge = lookup.body.result.structuredContent.result;
  assert.equal(knowledge.revision, revision); assert.equal(knowledge.results.length, 1);
  assert.equal(knowledge.results[0].source_url, 'https://shop.example/fabric#width');
  assert.equal(knowledge.results[0].value, '150 cm'); assert.equal(knowledge.inference_performed, false);
  assert.equal(JSON.stringify(lookup.body).includes('SECRET'), false); assert.equal(h.verifications.length, 0);
  const wrong = await h.mcp('search_merchant_knowledge', { merchant_id: 'different-merchant', query: 'width' });
  assert.equal(wrong.body.error.code, -32602);
  const long = await h.mcp('search_merchant_knowledge', { merchant_id: MERCHANT.merchantId, query: 'width ' + 'x'.repeat(444) });
  assert.equal(long.body.result.isError, undefined, 'The full advertised 500-character query must reach the repository.');
  const next = await h.admin('/knowledge', { method: 'POST', body: { facts: [fact({ value: '160 cm' })] } });
  const stale = await h.admin('/knowledge/activate', { method: 'POST', body: { revision: next.body.revision, expectedRevision: null } });
  assert.equal(stale.response.status, 409); assert.equal(stale.body.error.code, 'KNOWLEDGE_REVISION_CONFLICT');
  h.advance(61_000);
  const expired = await h.mcp('search_merchant_knowledge', { merchant_id: MERCHANT.merchantId, query: 'price' });
  assert.deepEqual(expired.body.result.structuredContent.result.results, []);
  assert.equal((await h.admin()).body.knowledge.currentFacts, 1);
  assert.equal(h.calls.length, 0);
});

test('claim observations reject forged platform status and compare against the server active knowledge', async t => {
  const h = setup(t), revision = await publish(h);
  const forged = await h.admin('/claim-evidence', { method: 'POST', body: event('claim_approved', 0, { platform_verified: true }) });
  assert.equal(forged.response.status, 400);
  const approvedEvent = event('claim_approved', 0);
  const approved = await h.admin('/claim-evidence', { method: 'POST', body: approvedEvent });
  assert.equal(approved.response.status, 200); assert.equal(approved.body.revision, 1); assert.equal(approved.body.platform_verified, false);
  const replay = await h.admin('/claim-evidence', { method: 'POST', body: approvedEvent });
  assert.equal(replay.body.replay, true); assert.equal(replay.body.revision, 1);
  const stale = await h.admin('/claim-evidence', { method: 'POST', body: event('persona_approved', 0) });
  assert.equal(stale.response.status, 409); assert.equal(stale.body.error.code, 'CLAIM_REVISION_CONFLICT');
  assert.equal((await h.admin('/claim-evidence', { method: 'POST', body: event('persona_approved', 1) })).response.status, 200);
  const inventedRevision = 'f'.repeat(64);
  const falsePreview = await h.admin('/claim-evidence', { method: 'POST', body: event('agent_preview_passed', 2, { knowledge_revision: inventedRevision }) });
  assert.equal(falsePreview.response.status, 409); assert.equal(falsePreview.body.error.code, 'CURRENT_KNOWLEDGE_EVIDENCE_REQUIRED');
  const override = await h.admin('/claim-evidence', { method: 'POST', body: event('agent_preview_passed', 2, { knowledge_revision: inventedRevision, activeKnowledgeRevision: inventedRevision }) });
  assert.equal(override.response.status, 400);
  assert.equal((await h.admin('/claim-evidence', { method: 'POST', body: event('agent_preview_passed', 2, { knowledge_revision: revision }) })).response.status, 200);
  const nextRevision = await publish(h, [fact({ value: '160 cm' })], revision);
  const stalePublication = await h.admin('/claim-evidence', { method: 'POST', body: event('agent_published', 3, { knowledge_revision: revision, agent_url: 'https://chatgpt.com/business/merchant-one' }) });
  assert.equal(stalePublication.response.status, 409); assert.equal(stalePublication.body.error.code, 'CURRENT_KNOWLEDGE_EVIDENCE_REQUIRED');
  const pack = await h.admin('/claim-pack');
  assert.equal(pack.response.status, 200); assert.equal(pack.body.knowledge_revision, nextRevision);
  assert.equal(pack.body.preview_matches_knowledge, false); assert.equal(pack.body.official_status_verified, false);
  assert.equal(pack.body.product_feed.generated, false); assert.equal(pack.body.approved_public_facts[0].source_url, fact().source_url);
  assert.equal(pack.body.owner_recorded_state.status_origin, 'owner_recorded'); assert.equal(h.calls.length, 0);
});

test('private editions and alternate origins cannot expose customer support while owner preparation remains available', async t => {
  const h = setup(t, { publication: 'private' });
  assert.equal((await h.admin()).response.status, 200);
  await publish(h);
  assert.equal((await h.admin('/claim-pack')).response.status, 200);
  for (const path of ['/api/buyer/support/merchant', '/.well-known/oauth-protected-resource/mcp']) {
    const result = await h.hit(path); assert.equal(result.response.status, 503); assert.equal(result.body.error.code, 'PRIVATE_EDITION');
  }
  assert.equal((await h.mcp('search_merchant_knowledge', { merchant_id: MERCHANT.merchantId, query: 'width' })).response.status, 503);
  assert.deepEqual(await h.routes.scheduled(h.env), { status: 'disabled' });
  assert.equal((await h.admin('', { requestOrigin: 'https://alternate.example' })).response.status, 403);
  assert.equal((await h.admin('', { headers: { Origin: 'https://different.example' } })).response.status, 403);
  assert.equal((await h.hit('/unrelated')).response, null);
  assert.equal(h.calls.length, 0);
});

test('same database retains merchant and site isolation across knowledge and owner state', async t => {
  const h = setup(t); await publish(h);
  await h.admin('/claim-evidence', { method: 'POST', body: event('claim_approved', 0) });
  for (const changed of [{ merchantId: 'merchant-two' }, { siteSlug: 'different-edition' }]) {
    const otherMerchant = { ...MERCHANT, ...changed };
    const server = h.makeRoutes({ ...h.config, siteSlug: otherMerchant.siteSlug });
    const environment = { ...h.env, BUYERSITE_MERCHANT_CONFIG: JSON.stringify({ version: 1, authorized: true, ...otherMerchant }) };
    const status = await h.admin('', { server, environment });
    assert.equal(status.response.status, 200); assert.equal(status.body.knowledge, null); assert.equal(status.body.onboarding.revision, 0);
    const result = await h.mcp('search_merchant_knowledge', { merchant_id: otherMerchant.merchantId, query: 'width' }, { server, environment });
    assert.deepEqual(result.body.result.structuredContent.result.results, []);
  }
  assert.equal(h.calls.length, 0);
});

test('OAuth-bound MCP writes reach Chatwoot once and polling returns only this buyer public messages', async t => {
  const h = setup(t);
  const input = { merchant_id: MERCHANT.merchantId, message: 'Please confirm the published width.', idempotency_key: crypto.randomUUID(), consent: CONSENT };
  const unlinked = await h.mcp('start_support_conversation', input);
  assert.equal(unlinked.body.result.isError, true); assert.ok(unlinked.body.result._meta['mcp/www_authenticate']);
  const missingScope = await h.mcp('start_support_conversation', input, { token: 'read-only' });
  assert.equal(missingScope.body.result.isError, true); assert.equal(h.calls.length, 0);
  const first = await h.mcp('start_support_conversation', input, { token: 'buyer-a' });
  assert.equal(first.response.status, 200); assert.equal(first.body.result.isError, undefined);
  const started = first.body.result.structuredContent;
  assert.equal(started.status, 'delivered'); assert.equal(started.delivered, true); assert.equal(started.providerReceipt, '30');
  assert.match(started.conversationId, /^[a-f0-9-]{36}$/);
  const again = await h.mcp('start_support_conversation', input, { token: 'buyer-a' });
  assert.deepEqual(again.body.result.structuredContent, started);
  assert.equal(h.calls.filter(call => call.method === 'POST' && call.url.endsWith('/conversations')).length, 1);
  assert.equal(h.calls.filter(call => call.method === 'POST' && call.url.endsWith('/contacts')).length, 1);
  const sentInput = { merchant_id: MERCHANT.merchantId, conversation_id: started.conversationId, message: 'Please send the specification source.', idempotency_key: crypto.randomUUID() };
  const sent = await h.mcp('send_support_message', sentInput, { token: 'buyer-a' });
  assert.equal(sent.body.result.structuredContent.status, 'delivered'); assert.equal(sent.body.result.structuredContent.messageId, '201');
  await h.mcp('send_support_message', sentInput, { token: 'buyer-a' });
  assert.equal(h.calls.filter(call => call.method === 'POST' && call.url.endsWith('/messages')).length, 1);
  const updates = await h.mcp('get_support_updates', { merchant_id: MERCHANT.merchantId, conversation_id: started.conversationId, cursor: '100' }, { token: 'buyer-a' });
  const update = updates.body.result.structuredContent;
  assert.deepEqual(update.messages.map(message => message.id), ['101', '102']); assert.equal(update.nextCursor, '104');
  assert.equal(update.messages[1].direction, 'merchant'); assert.equal(update.messages[1].content, 'The published width is 150 cm.');
  for (const secret of ['PRIVATE STAFF NOTE', 'INTERNAL STATUS ACTIVITY', ADMIN_TOKEN, CHATWOOT_TOKEN]) assert.equal(JSON.stringify(update).includes(secret), false);
  assert.ok(update.delivery.some(receipt => receipt.operationId === started.operationId && receipt.delivered));
  const callsBefore = h.calls.length;
  const otherBuyer = await h.mcp('get_support_updates', { merchant_id: MERCHANT.merchantId, conversation_id: started.conversationId }, { token: 'buyer-b' });
  assert.equal(otherBuyer.body.result.structuredContent.error, 'CONVERSATION_NOT_FOUND'); assert.equal(h.calls.length, callsBefore);
  const human = await h.mcp('request_human_support', { merchant_id: MERCHANT.merchantId, conversation_id: started.conversationId, idempotency_key: crypto.randomUUID() }, { token: 'buyer-a' });
  assert.equal(human.body.result.structuredContent.humanRequested, true); assert.equal(human.body.result.structuredContent.supportStatus, 'open');
  assert.equal(h.sqlite.prepare('SELECT handoff_requested FROM merchant_support_threads').get().handoff_requested, 1);
  const storage = JSON.stringify(h.sqlite.prepare('SELECT * FROM merchant_support_threads').all());
  assert.equal(storage.includes('buyer-a'), false); assert.equal(storage.includes(input.message), false);
});

test('owner drain and reconciliation routes retain the authentication and evidence boundary', async t => {
  const h = setup(t);
  const drain = await h.admin('/drain', { method: 'POST', body: {} });
  assert.equal(drain.response.status, 200); assert.equal(drain.body.status, 'needs_connection'); assert.equal(drain.body.redactedJobs, 0);
  const input = { operationId: crypto.randomUUID(), expectedUpdatedAt: NOW, resolution: 'not_delivered', evidenceRef: 'support-review:123', evidenceHash: 'a'.repeat(64) };
  const unlinked = await h.admin('/reconcile', { token: 'buyer-a', method: 'POST', body: input });
  assert.equal(unlinked.response.status, 401);
  const unknown = await h.admin('/reconcile', { method: 'POST', body: input });
  assert.equal(unknown.response.status, 404); assert.equal(unknown.body.error.code, 'OPERATION_NOT_FOUND');
  const forged = await h.admin('/reconcile', { method: 'POST', body: { ...input, actorId: 'spoofed' } });
  assert.equal(forged.response.status, 400); assert.equal(h.calls.length, 0);
});
