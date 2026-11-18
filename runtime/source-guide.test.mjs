import test from 'node:test';
import assert from 'node:assert/strict';
import { searchSourceRecords, buildSourceGuideReply } from './source-guide.mjs';
import { createGateway } from './gateway.mjs';

const record = {
  id: 'silver-width', title: 'Silver wool fabric', claim: 'Silver width', value: '140 cm',
  source_url: 'https://supplier.example/products/silver', page_path: '/materials/silver',
  status: 'supplier-stated', captured_at: '2026-11-18T00:00:00.000Z',
};
const config = { siteSlug: 'material-notes', allowedPaths: ['/', '/materials/silver'], sourceRecords: [record] };

test('source guide returns exact cited facts and never invents an answer when evidence is absent', () => {
  assert.deepEqual(searchSourceRecords('What is the width?', config), [record]);
  assert.deepEqual(searchSourceRecords('What is the wholesale price or MOQ?', config), []);
  const privateRecord = { ...record, id: 'private', email: 'never-return@example.test', page_path: '/private' };
  const unsafeRecord = { ...record, id: 'unsafe', source_url: 'javascript:alert(1)' };
  const extraFields = { ...record, email: 'never-return@example.test', internal_note: 'private brief' };
  const results = searchSourceRecords('width', { ...config, sourceRecords: [extraFields, privateRecord, unsafeRecord] });
  assert.deepEqual(results, [record]);
  assert.doesNotMatch(JSON.stringify(results), /never-return|private brief/);
});

test('selected-article lookup cannot blend another product and unknown terms remain explicit', () => {
  const scoped = {
    ...config, allowedPaths: [...config.allowedPaths, '/materials/other'],
    sourceRecords: [record, { ...record, id: 'other-width', page_path: '/materials/other', value: '190 cm' }],
    buyerBriefs: [{ page_path: '/materials/silver/', title: record.title,
      unconfirmed: [{ id: 'price', label: 'Trade price', detail: 'Request a current quote.' }],
      questions: [{ id: 'quote', label: 'Quote', prompt: 'Confirm the quantity-specific price.' }] }],
  };
  const answer = buildSourceGuideReply('width', scoped, '/materials/silver');
  assert.deepEqual(answer.results, [record]);
  assert.equal(answer.context.unconfirmed[0].status, 'unconfirmed');
  assert.equal(answer.inference_performed, false);
  const unknown = buildSourceGuideReply('price', scoped, '/materials/silver');
  assert.deepEqual(unknown.results, []);
  assert.match(unknown.context.unconfirmed[0].detail, /current quote/);
});

test('source guide endpoint works without model keys and rejects foreign-origin and cross-edition searches', async () => {
  const gateway = createGateway(config);
  const request = (body, origin = 'https://buyersite.example') => new Request('https://buyersite.example/api/buyer/source-guide', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body),
  });
  const good = await gateway.fetch(request({ query: 'width', site_slug: config.siteSlug }), {});
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { mode: 'source-guide', method: 'keyword-search', results: [record], inference_performed: false });
  assert.equal((await gateway.fetch(request({ query: 'width', site_slug: 'other-site' }), {})).status, 400);
  assert.equal((await gateway.fetch(request({ query: 'width', site_slug: config.siteSlug }, 'https://other.example'), {})).status, 403);
  assert.equal((await gateway.fetch(request(null), {})).status, 400);
  assert.equal((await gateway.fetch(request({ query: null, site_slug: config.siteSlug }), {})).status, 400);
});
