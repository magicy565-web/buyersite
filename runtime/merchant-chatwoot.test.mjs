import test from 'node:test';
import assert from 'node:assert/strict';
import { createMerchantChatwootClient, ChatwootClientError } from './merchant-chatwoot.mjs';

const merchant = { merchantId: 'merchant-one', siteSlug: 'merchant-one', name: 'Example Merchant', origin: 'https://merchant.example', privacyUrl: 'https://merchant.example/privacy', authorizationRef: 'authorization-fixture-v1', chatwoot: { baseUrl: 'https://support.example', accountId: 8, websiteInboxId: 20, apiInboxId: 21 } };
const apiToken = 'test-service-token-0123456789';
const agentBotToken = 'test-agentbot-token-0123456789';
const state = overrides => ({ id: 35, account_id: 8, inbox_id: 21, status: 'pending', meta: { sender: { id: 90 }, assignee_type: 'AgentBot', assignee: { id: 12 } }, messages: [], ...overrides });
const message = overrides => ({ id: 101, inbox_id: 21, conversation_id: 35, message_type: 0, private: false, content: 'Material width?', created_at: 1790000000, ...overrides });

function fixture(handler) {
  const calls = [];
  const client = createMerchantChatwootClient({ merchant, apiToken, agentBotToken, fetchFn: async (url, options) => {
    const call = { url, ...options, json: options.body ? JSON.parse(options.body) : null };
    calls.push(call);
    return handler(call);
  } });
  return { client, calls };
}

test('server binding controls contact and native initial incoming conversation creation', async () => {
  const { client, calls } = fixture(call => Response.json(call.url.endsWith('/contacts') ? { payload: { contact: { id: 90, identifier: 'buyer:opaque' }, contact_inbox: { inbox: { id: 21 }, source_id: 'bound-source' } } } : state()));
  assert.deepEqual(await client.createContact({ identifier: 'buyer:opaque', inbox_id: 999 }), { id: 90, sourceId: 'bound-source' });
  const conversation = await client.createConversation({ contactId: 90, sourceId: 'bound-source', message: 'Material width?', account_id: 999 });
  assert.equal(conversation.id, 35);
  assert.equal(conversation.contactId, 90);
  assert.equal(conversation.meta.sender.id, 90);
  assert.equal(conversation.accountId, 8);
  assert.equal(conversation.inboxId, 21);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.url.startsWith('https://support.example/api/v1/accounts/8/') && call.headers.Authorization === `Bearer ${apiToken}` && call.redirect === 'error'));
  assert.deepEqual(calls[1].json, { inbox_id: 21, contact_id: 90, source_id: 'bound-source', status: 'pending', message: { content: 'Material width?', message_type: 'incoming', private: false, content_type: 'text' } });
});

test('conversation reads enforce merchant account, allowed inbox and bound contact', async () => {
  for (const override of [{ account_id: 9 }, { inbox_id: 999 }, { id: 99 }, { meta: { sender: { id: 91 } } }]) {
    const { client, calls } = fixture(() => Response.json(state(override)));
    await assert.rejects(client.getConversation({ conversationId: 35, contactId: 90 }), error => ['CHATWOOT_BINDING_MISMATCH', 'CHATWOOT_CONTACT_MISMATCH'].includes(error.code));
    assert.equal(calls.length, 1);
  }
});

test('incoming messages require API inbox and never use the AgentBot credential', async () => {
  const rejected = fixture(() => Response.json(state({ inbox_id: 20 })));
  await assert.rejects(rejected.client.sendIncoming({ conversationId: 35, contactId: 90, content: 'Hello' }), { code: 'INCOMING_REQUIRES_API_INBOX' });
  assert.equal(rejected.calls.length, 1);
  const accepted = fixture(call => Response.json(call.method === 'GET' ? state() : message()));
  assert.equal((await accepted.client.sendIncoming({ conversationId: 35, contactId: 90, content: 'Hello', sourceId: 'correlation-only' })).message_type, 'incoming');
  assert.ok(accepted.calls.every(call => call.headers.Authorization === `Bearer ${apiToken}`));
  assert.equal(accepted.calls[1].json.source_id, 'correlation-only');
});

test('history is ordered, bounded by cursor and excludes private notes, activity and internal metadata', async () => {
  const { client, calls } = fixture(call => Response.json(call.url.includes('/messages?') ? { meta: { contact: { email: 'private@example.test' } }, payload: [
    message({ id: 105, message_type: 1, content: 'Public answer', source_id: 'internal-source', sender: { type: 'agent_bot', id: 12, email: 'private@example.test' } }),
    message({ id: 104, private: true, content: 'Internal note' }), message({ id: 103, message_type: 2 }), message({ id: 102 }),
  ] } : state()));
  const result = await client.listPublicMessages({ conversationId: 35, contactId: 90, after: 100 });
  assert.deepEqual(result.messages.map(item => item.id), [102, 105]);
  assert.equal(result.nextCursor, 105);
  assert.equal(JSON.stringify(result).includes('private@example.test'), false);
  assert.equal(JSON.stringify(result).includes('internal-source'), false);
  assert.equal(calls[1].url, 'https://support.example/api/v1/accounts/8/conversations/35/messages?filter_internal_messages=true&after=100');
});

test('history rejects a response containing another conversation', async () => {
  const { client } = fixture(call => Response.json(call.url.includes('/messages?') ? { payload: [message({ conversation_id: 77 })] } : state()));
  await assert.rejects(client.listPublicMessages({ conversationId: 35 }), { code: 'CHATWOOT_BINDING_MISMATCH' });
});

test('AgentBot replies use bot credential and preserve reply correlation', async () => {
  const { client, calls } = fixture(call => Response.json(call.method === 'GET' ? state() : message({ message_type: 1 })));
  const result = await client.sendAgentReply({ conversationId: 35, content: 'Published width is 150 cm.', inReplyTo: 99, expectedAgentBotId: 12, sourceId: 'job:1' });
  assert.equal(result.message_type, 'outgoing');
  assert.ok(calls.every(call => call.headers.Authorization === `Bearer ${agentBotToken}`));
  assert.equal(calls[1].json.message_type, 'outgoing');
  assert.equal(calls[1].json.private, false);
  assert.deepEqual(calls[1].json.content_attributes, { in_reply_to: 99 });
});

test('latest human control, different bot, missing bot binding and superseded message all prevent outgoing POST', async () => {
  for (const [override, expectedAgentBotId, code] of [
    [{ status: 'open' }, 12, 'HUMAN_HAS_CONTROL'],
    [{ meta: { sender: { id: 90 }, assignee_type: 'User', assignee: { id: 5 } } }, 12, 'HUMAN_HAS_CONTROL'],
    [{}, 99, 'AGENTBOT_ASSIGNMENT_CHANGED'], [{}, undefined, 'AGENTBOT_ASSIGNMENT_CHANGED'],
    [{ messages: [message({ id: 100 })] }, 12, 'MESSAGE_SUPERSEDED'],
    [{ last_non_activity_message: message({ id: 100 }) }, 12, 'MESSAGE_SUPERSEDED'],
  ]) {
    const { client, calls } = fixture(() => Response.json(state(override)));
    await assert.rejects(client.sendAgentReply({ conversationId: 35, content: 'Answer', inReplyTo: 99, expectedAgentBotId }), { code });
    assert.equal(calls.length, 1);
  }
});

test('handoff explicitly opens pending conversation, handles native null success, and leaves other states alone', async () => {
  const pending = fixture(call => Response.json(call.method === 'GET' ? state() : { payload: { success: null, current_status: 'open', conversation_id: 35 } }));
  assert.deepEqual(await pending.client.requestHuman({ conversationId: 35 }), { status: 'open', handedOff: true });
  assert.deepEqual(pending.calls[1].json, { status: 'open' });
  for (const status of ['open', 'resolved', 'snoozed']) {
    const current = fixture(() => Response.json(state({ status })));
    assert.deepEqual(await current.client.requestHuman({ conversationId: 35 }), { status, handedOff: false });
    assert.equal(current.calls.length, 1);
  }
});

test('ambiguous write outcomes are reported once and never retried', async () => {
  for (const response of [() => { throw new Error('transport'); }, () => new Response('error', { status: 500 }), () => new Response('not-json'), () => Response.json({ id: 'bad' })]) {
    const { client, calls } = fixture(call => call.method === 'GET' ? Response.json(state()) : response());
    await assert.rejects(client.sendIncoming({ conversationId: 35, content: 'Hello' }), error => error instanceof ChatwootClientError && error.ambiguous === true);
    assert.equal(calls.length, 2);
  }
  const certain = fixture(call => call.method === 'GET' ? Response.json(state()) : new Response('rejected', { status: 422 }));
  await assert.rejects(certain.client.sendIncoming({ conversationId: 35, content: 'Hello' }), error => error.status === 422 && error.ambiguous === false);
});

test('invalid server configuration and missing credentials fail before network access', async () => {
  for (const baseUrl of ['http://support.example', 'https://a:b@support.example', 'https://support.example/path', 'https://support.example/?secret=x']) {
    assert.throws(() => createMerchantChatwootClient({ merchant: { ...merchant, chatwoot: { ...merchant.chatwoot, baseUrl } }, apiToken }), { code: 'INVALID_CHATWOOT_ORIGIN' });
  }
  assert.throws(() => createMerchantChatwootClient({ merchant: { ...merchant, authorizationRef: '' }, apiToken }), { code: 'MERCHANT_NOT_AUTHORIZED' });
  let called = false;
  const client = createMerchantChatwootClient({ merchant, fetchFn: async () => { called = true; } });
  await assert.rejects(client.getConversation({ conversationId: 35 }), { code: 'CHATWOOT_API_TOKEN_NOT_CONFIGURED' });
  assert.equal(called, false);
});

test('durable control hook is checked after Chatwoot preflight and before the outgoing POST', async () => {
  for (const beforeSend of [async () => false, async () => { throw new Error('control unavailable'); }]) {
    const { client, calls } = fixture(() => Response.json(state()));
    await assert.rejects(client.sendAgentReply({ conversationId: 35, content: 'Answer', inReplyTo: 99, expectedAgentBotId: 12, beforeSend }), { code: 'HUMAN_HAS_CONTROL' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
  }
});
