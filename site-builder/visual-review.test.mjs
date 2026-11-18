import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { reviewBuiltSite, reviewScreenshots, VisualReviewError } from './visual-review.mjs';

const verdict = {
  decision: 'pass', editorial_quality: 5, hierarchy: 4,
  mobile_readability: 5, authenticity: 5, issues: [],
};

test('review is blocked until both consent and credentials are present', async () => {
  const result = await reviewBuiltSite({ authorized: false, apiKey: 'test', artifactSha256: 'a'.repeat(64) });
  assert.equal(result.status, 'PENDING_CONFIGURATION');
  assert.equal(result.publication, 'BLOCKED');
  assert.equal(result.human_approval_required, true);
});

test('real screenshot review receives desktop and mobile images and binds artifact hash', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'visual-review-'));
  try {
    const root = join(dir, 'source');
    await mkdir(root);
    await writeFile(join(root, 'pages.json'), JSON.stringify([
      { page_id: 'home', path: '/', page_type: 'home', title: 'Magazine' },
      { page_id: 'sample', path: '/products/sample/', page_type: 'product-editorial', title: 'Sample' },
    ]));
    await writeFile(join(root, 'media-report.json'), JSON.stringify({ images: [{ page_id: 'sample', kind: 'ai-generated' }] }));
    const bytes = await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#b9b6ac' } }).png().toBuffer();
    const result = await reviewBuiltSite({
      authorized: true, apiKey: 'synthetic-test', artifactDir: dir, jobDir: dir,
      sourceRoot: root, artifactSha256: 'c'.repeat(64),
      captureFn: async () => [{ name: 'desktop', bytes }, { name: 'mobile', bytes }],
      reviewFn: async () => verdict,
    });
    assert.equal(result.status, 'PASS_RECOMMENDED');
    assert.equal(result.publication, 'BLOCKED');
    assert.equal(result.pages.length, 2);
    assert.equal(result.pages[0].screenshots.length, 2);
    const failed = await reviewBuiltSite({
      authorized: true, apiKey: 'synthetic-test', artifactDir: dir, jobDir: dir,
      sourceRoot: root, artifactSha256: 'c'.repeat(64),
      captureFn: async () => [{ name: 'desktop', bytes }, { name: 'mobile', bytes }],
      reviewFn: async () => ({ ...verdict, mobile_readability: 2, issues: [{ severity: 'major', problem: 'Small text', recommendation: 'Increase type size' }] }),
    });
    assert.equal(failed.status, 'REVISION_REQUIRED');
    assert.equal(failed.publication, 'BLOCKED');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('vision provider request includes actual images and strict JSON schema', async () => {
  const tiny = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#555555' } }).png().toBuffer();
  const fetchImpl = async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const payload = JSON.parse(request.body);
    assert.equal(payload.store, false);
    assert.equal(payload.text.format.type, 'json_schema');
    assert.equal(payload.input[0].content.filter((c) => c.type === 'input_image').length, 2);
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(verdict) }] }] }) };
  };
  const result = await reviewScreenshots({
    screenshots: [{ bytes: tiny }, { bytes: tiny }], apiKey: 'synthetic-test',
    page: { page_id: 'sample', title: 'Page' }, media: { kind: 'abstract-fallback' }, fetchImpl,
  });
  assert.equal(result.decision, 'pass');
  await assert.rejects(() => reviewScreenshots({
    screenshots: [{ bytes: tiny }, { bytes: tiny }], apiKey: 'synthetic-test',
    fetchImpl: async () => ({ ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{\"decision\":\"pass\"}' }] }] }) }),
  }), VisualReviewError);
});
