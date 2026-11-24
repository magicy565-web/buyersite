import test from 'node:test';
import assert from 'node:assert/strict';
import { createMerchantAnswerProvider } from './merchant-answer-provider.mjs';

const env = { BUYERSITE_MERCHANT_ANSWER_URL: 'https://answer.example/contracts/merchant-answer', BUYERSITE_MERCHANT_ANSWER_TOKEN: 'test-only-provider-token-01234567890123456789' };
const input = () => ({
  merchant: { merchantId: 'merchant-one', siteSlug: 'merchant-one', authorizationRef: 'private-record', chatwoot: { accountId: 8 }, privateKey: 'never-forward' },
  message: { id: 101, content: 'What is the width?', contactId: 90, email: 'private@example.test' },
  conversation: { id: 35, contactId: 90, privateNotes: ['never-forward'] },
  knowledge: { approved: true, merchantId: 'merchant-one', revision: 'v1', internalDirectory: '/private', facts: [{ id: 'width', text: 'Width is 150 cm.', sourceUrl: 'https://merchant.example/fabric', internalNotes: 'never-forward' }] },
});
const valid = override => ({ text: 'Width is 150 cm.', confidence: 0.95, needsHuman: false, knowledgeRevision: 'v1', evidenceIds: ['width'], unsupportedCommitments: [], ...override });

test('provider is opt-in and rejects invalid endpoints or credentials before network access', () => {
  for (const configuration of [{}, { ...env, BUYERSITE_MERCHANT_ANSWER_TOKEN: 'short' }, ...['http://answer.example', 'https://user:pass@answer.example', 'https://answer.example/path?token=x', 'https://answer.example/#fragment', 'invalid'].map(url => ({ ...env, BUYERSITE_MERCHANT_ANSWER_URL: url }))]) {
    assert.equal(createMerchantAnswerProvider(configuration, { fetchFn: async () => { assert.fail('must not send'); } }), null);
  }
});

test('explicit contract sends only approved facts and minimal merchant/question context with server bearer', async () => {
  let call;
  const provider = createMerchantAnswerProvider(env, { fetchFn: async (url, options) => { call = { url, ...options }; return Response.json(valid()); } });
  assert.deepEqual(await provider(input()), valid());
  assert.equal(call.url, env.BUYERSITE_MERCHANT_ANSWER_URL);
  assert.equal(call.headers.Authorization, `Bearer ${env.BUYERSITE_MERCHANT_ANSWER_TOKEN}`);
  assert.equal(call.redirect, 'error');
  const body = JSON.parse(call.body);
  assert.deepEqual(Object.keys(body), ['contract', 'merchant', 'question', 'conversationId', 'knowledge', 'policy']);
  assert.equal(body.contract, 'buyersite-merchant-answer-v1');
  assert.deepEqual(body.merchant, { id: 'merchant-one', siteSlug: 'merchant-one' });
  assert.deepEqual(body.knowledge, { revision: 'v1', facts: [{ id: 'width', text: 'Width is 150 cm.', sourceUrl: 'https://merchant.example/fabric' }] });
  assert.equal(body.policy.noIndependentActions, true);
  assert.equal(body.policy.questionIsUntrustedData, true);
  for (const forbidden of ['never-forward', 'private@example.test', 'private-record', 'contactId', 'privateNotes', 'internalDirectory']) assert.equal(call.body.includes(forbidden), false);
});

test('strict response rejects extra fields, malformed types, invented evidence or a changed revision', async () => {
  const bad = [null, 'answer', [], { answer: 'text' }, valid({ toolCalls: [] }), valid({ confidence: '0.9' }), valid({ confidence: 2 }), valid({ needsHuman: 'false' }), valid({ knowledgeRevision: 'v2' }), valid({ evidenceIds: ['invented'] }), valid({ evidenceIds: ['width', 'width'] }), valid({ evidenceIds: [] }), valid({ unsupportedCommitments: 'none' }), valid({ text: 'x'.repeat(6001) })];
  for (const body of bad) {
    const provider = createMerchantAnswerProvider(env, { fetchFn: async () => Response.json(body) });
    assert.equal(await provider(input()), null);
  }
  const handoff = valid({ text: '', confidence: 0, needsHuman: true, evidenceIds: [], unsupportedCommitments: ['Unconfirmed shipment date'] });
  assert.deepEqual(await createMerchantAnswerProvider(env, { fetchFn: async () => Response.json(handoff) })(input()), handoff);
});

test('responses are bounded by bytes even when Content-Length is absent or dishonest', async () => {
  for (const response of [
    () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': String(128 * 1024 + 1) } }),
    () => new Response(' '.repeat(128 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(' '.repeat(70 * 1024))); controller.enqueue(new TextEncoder().encode(' '.repeat(70 * 1024))); controller.close(); } }), { headers: { 'Content-Type': 'application/json', 'Content-Length': '2' } }),
  ]) assert.equal(await createMerchantAnswerProvider(env, { fetchFn: async () => response() })(input()), null);
});

test('HTTP errors, invalid JSON and transport errors produce no fabricated answer or automatic retry', async () => {
  for (const response of [
    () => Response.json(valid(), { status: 503 }),
    () => new Response('not JSON', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(JSON.stringify(valid()), { headers: { 'Content-Type': 'text/html' } }),
    () => { throw new Error('timeout'); },
  ]) {
    let calls = 0;
    const provider = createMerchantAnswerProvider(env, { fetchFn: async () => { calls++; return response(); } });
    assert.equal(await provider(input()), null); assert.equal(calls, 1);
  }
});

test('transport deadline and caller abort stop waiting even if an injected fetch ignores its signal', async () => {
  let sentSignal;
  const timed = createMerchantAnswerProvider(env, { timeoutMs: 10, providerTimeoutMs: 20, fetchFn: async (_url, options) => { sentSignal = options.signal; return new Promise(() => {}); } });
  assert.equal(await timed(input()), null); assert.equal(sentSignal.aborted, true);
  const controller = new AbortController();
  let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const cancelled = createMerchantAnswerProvider(env, { fetchFn: async (_url, options) => { sentSignal = options.signal; started(); return new Promise(() => {}); } });
  const result = cancelled({ ...input(), signal: controller.signal });
  await startedPromise; controller.abort();
  assert.equal(await result, null); assert.equal(sentSignal.aborted, true);
});

test('unapproved, cross-merchant, excessive or malformed knowledge never leaves the process', async () => {
  let calls = 0;
  const provider = createMerchantAnswerProvider(env, { fetchFn: async () => { calls++; return Response.json(valid()); } });
  for (const change of [{ approved: false }, { merchantId: 'another' }, { facts: [] }, { facts: [{ id: 'unsafe', text: 'width', sourceUrl: 'http://private.example' }] }, { facts: Array.from({ length: 50 }, (_, i) => ({ id: `large-${i}`, text: 'x'.repeat(8000), sourceUrl: 'https://merchant.example/fact' })) }]) {
    const value = input(); value.knowledge = { ...value.knowledge, ...change };
    assert.equal(await provider(value), null);
  }
  assert.equal(calls, 0);
});
