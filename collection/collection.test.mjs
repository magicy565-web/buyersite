import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureWebsitePage, collectSources, projectWebsitePages, LIMITS } from './index.mjs';
import { captureCompanyHomepage } from './website.mjs';

const html = '<html><title>Supplier A</title><p>Example source for testing only. These product materials are synthetic and do not constitute a supplier claim.</p></html>';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const transport = {
  lookup: async () => ['93.184.216.34'],
  get: async (url) => url.pathname === '/robots.txt'
    ? { status: 404, contentType: 'text/plain', body: '' }
    : { status: 200, contentType: 'text/html; charset=utf-8', body: html, bytes: Buffer.from(html) },
};
const capture = (url) => captureWebsitePage(url, transport);
const base = { authorized: true, enterprise_id: 'test-enterprise' };
const doc = (name, media_type, bytes) => ({ name, media_type, bytes: Buffer.from(bytes), source_kind: 'operator-upload' });

test('independent capture preserves raw bytes, text and legacy builder shape', async () => {
  const result = await capture('https://example.com/products');
  assert.equal(result.raw_content_sha256, hash(html));
  assert.equal(Buffer.from(result.raw_content_base64, 'base64').toString(), html);
  assert.equal(result.content_sha256, hash(result.body_text));
  const legacy = await captureCompanyHomepage('https://example.com/products', transport);
  assert.deepEqual(Object.keys(legacy), ['url', 'title', 'body_text', 'content_sha256', 'captured_at']);
});

test('collects multiple explicit URLs and original documents without publishing', async () => {
  const input = { ...base, website_urls: ['https://example.com/', 'https://example.com/products', 'https://other.example/specs'],
    documents: [doc('catalog.csv', 'text/csv', 'sku,qty\nA,2\n'), doc('profile.json', 'application/json', '{"company":"A"}'),
      doc('catalog.pdf', 'application/pdf', '%PDF-synthetic')] };
  const result = await collectSources(input, { capture });
  assert.equal(result.status, 'complete');
  assert.deepEqual(result.counts, { requested: 6, captured: 6, failed: 0 });
  assert.equal(result.publication_permission, 'not-granted');
  assert.equal(result.records[3].document.body_text, 'sku,qty\nA,2\n');
  assert.equal(result.records[4].document.extraction_status, 'text-available');
  assert.equal(result.records[5].document.extraction_status, 'raw-only');
  assert.equal(result.records[5].document.body_text, null);
  assert.equal(result.records[5].document.content_sha256, hash('%PDF-synthetic'));
  assert.equal(projectWebsitePages(result, { enterprise_id: base.enterprise_id, company_website: 'https://example.com/' }).length, 2);
  assert.equal(projectWebsitePages(result, { enterprise_id: base.enterprise_id, company_website: 'https://example.com/' })[0].raw_content_base64, undefined);
  assert.throws(() => projectWebsitePages(result, { enterprise_id: 'other-tenant', company_website: 'https://example.com/' }), { code: 'COLLECTION_HANDOFF_BLOCKED' });
  const repeat = await collectSources(input, { capture });
  assert.deepEqual(result.records.map(r => r.source_id), repeat.records.map(r => r.source_id));
});

test('invalid scope and duplicate input are rejected before network access', async () => {
  let called = false;
  const never = async () => { called = true; };
  await assert.rejects(collectSources({ ...base, authorized: false, website_urls: ['https://example.com/'] }, { capture: never }), { code: 'COLLECTION_AUTHORIZATION_REQUIRED' });
  await assert.rejects(collectSources({ ...base, website_urls: ['https://example.com/#one', 'https://example.com/#two'] }, { capture: never }), { code: 'DUPLICATE_SOURCE' });
  await assert.rejects(collectSources({ ...base, website_urls: ['http://example.com/'] }, { capture: never }), { code: 'INVALID_URL' });
  await assert.rejects(collectSources({ ...base, documents: [doc('too-large.txt', 'text/plain', Buffer.alloc(LIMITS.documentBytes + 1))] }, { capture: never }), { code: 'INVALID_DOCUMENT' });
  assert.equal(called, false);
});

test('partial results retain successful sources and refuse builder handoff', async () => {
  const blocked = (url) => captureWebsitePage(url, { ...transport,
    get: async (u) => u.pathname === '/robots.txt' ? { status: 200, body: 'User-agent: *\nDisallow: /' } : transport.get(u) });
  const result = await collectSources({ ...base, website_urls: ['https://example.com/'],
    documents: [doc('bad.json', 'application/json', '{oops'), doc('good.txt', 'text/plain', 'actual supplied text')] }, { capture: blocked });
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.counts, { requested: 3, captured: 1, failed: 2 });
  assert.equal(result.records[0].error_code, 'ROBOTS_BLOCKED');
  assert.equal(result.records[1].error_code, 'INVALID_DOCUMENT_TEXT');
  assert.equal(result.records[2].document.body_text, 'actual supplied text');
  assert.throws(() => projectWebsitePages(result, { enterprise_id: base.enterprise_id, company_website: 'https://example.com/' }), { code: 'COLLECTION_HANDOFF_BLOCKED' });
});

test('raw content tampering and cross-domain captures fail closed', async () => {
  const result = await collectSources({ ...base, website_urls: ['https://example.com/'] }, {
    capture: async url => ({ ...await capture(url), raw_content_sha256: '0'.repeat(64) }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.records[0].error_code, 'SOURCE_HASH_MISMATCH');
  const other = await collectSources({ ...base, website_urls: ['https://example.com/'] }, {
    capture: async () => capture('https://other.example/'),
  });
  assert.equal(other.records[0].error_code, 'CROSS_DOMAIN_SOURCE');
});

test('website network guards reject unsafe DNS, disallowed redirects and oversized bodies', async () => {
  await assert.rejects(captureWebsitePage('https://example.com/', { ...transport, lookup: async () => ['127.0.0.1'] }), { code: 'PRIVATE_ADDRESS' });
  await assert.rejects(captureWebsitePage('https://example.com/', { ...transport, get: async u => u.pathname === '/robots.txt'
    ? transport.get(u) : { status: 302, location: 'https://other.example/' } }), { code: 'CROSS_DOMAIN_REDIRECT' });
  await assert.rejects(captureWebsitePage('https://example.com/', { ...transport, get: async u => u.pathname === '/robots.txt'
    ? transport.get(u) : { status: 200, contentType: 'text/html', body: 'x'.repeat(900001) } }), { code: 'SOURCE_TOO_LARGE' });
});
