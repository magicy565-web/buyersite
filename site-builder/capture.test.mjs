import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { captureCompanyHomepage, robotsAllows } from './capture.mjs';
import { createSiteFromEnterprise } from './from-enterprise.mjs';

const html = '<html><head><title>Example supplier</title></head><body><main><h1>Company example</h1><p>Textile materials are presented by a synthetic example website solely for collector tests and no real product approval is implied.</p></main></body></html>';
const transport = {
  lookup: async () => ['93.184.216.34'],
  get: async (url, pin) => {
    assert.equal(pin, '93.184.216.34');
    return url.pathname === '/robots.txt'
      ? { status: 404, contentType: 'text/plain', body: '' }
      : { status: 200, contentType: 'text/html; charset=utf-8', body: html };
  },
};

test('captures bounded HTML text from a pinned public HTTPS host only', async () => {
  const snapshot = await captureCompanyHomepage('https://example.com/', transport);
  assert.equal(snapshot.url, 'https://example.com/');
  assert.ok(snapshot.body_text.includes('Textile materials'));
  assert.match(snapshot.content_sha256, /^[a-f0-9]{64}$/);
  assert.ok(snapshot.captured_at.endsWith('Z'));
});

test('honours robots exclusion and rejects rebinding to a private host', async () => {
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\n', '/'), false);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /private\n', '/public'), true);
  await assert.rejects(captureCompanyHomepage('https://example.com/', {
    ...transport, lookup: async () => ['127.0.0.1'],
  }), (error) => error.code === 'PRIVATE_ADDRESS');
  await assert.rejects(captureCompanyHomepage('https://example.com/', {
    ...transport, get: async (url) => url.pathname === '/robots.txt'
      ? { status: 200, contentType: 'text/plain', body: 'User-agent: *\nDisallow: /' }
      : { status: 200, contentType: 'text/html', body: html },
  }), (error) => error.code === 'ROBOTS_BLOCKED');
});

test('authenticated export plus collector snapshot writes a private supplier edition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'buyer-website-'));
  try {
    const nativeExport = {
      enterprise: {
        id: 'synthetic-tenant', revision: 2,
        company: {displayName: 'Example supplier', website: 'https://example.com/', description: 'Synthetic test description.'},
        products: [{ id: 'test-p', name: 'Textile material', description: 'Synthetic product description.' }],
      },
    };
    const snapshot = await captureCompanyHomepage('https://example.com/', transport);
    const built = await createSiteFromEnterprise(nativeExport, { capture: async () => snapshot, outputBase: root });
    const manifest = JSON.parse(await readFile(join(built.root, 'manifest.json'), 'utf8'));
    const receipt = JSON.parse(await readFile(join(built.root, 'receipt.json'), 'utf8'));
    assert.equal(manifest.assistant.enabled, false);
    assert.equal(manifest.routes.length, 4);
    assert.equal(receipt.preview_only, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
