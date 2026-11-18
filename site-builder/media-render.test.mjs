import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { planMedia } from './media-policy.mjs';
import { planEditorialVisuals } from './visual-director.mjs';
import { materializeEditionMedia } from './media-render.mjs';
import { importApprovedPhoto } from './media-import.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const articles = [
  { slug: 'product', title: 'Cotton Canvas', pageType: 'product-editorial' },
  { slug: 'guide', title: 'Buying Guide', pageType: 'buyer-guide' },
];
const visualPlan = planEditorialVisuals({ companyName: 'Textile Mill', categories: ['Textiles'], articles });
test('synthetic authored art and grant complete import, plan and licensed-path rendering with tenant isolation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-acceptance-'));
  try {
    const tenant = join(dir, 'registry', 'enterprise-01');
    const articlesDir = join(dir, 'out');
    await mkdir(tenant, { recursive: true });
    await mkdir(articlesDir);
    const bytes = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#acb8a0' } }).png().toBuffer();
    const imagePath = join(dir, 'synthetic-test-art.png');
    const rightsDocumentPath = join(dir, 'synthetic-test-grant.txt');
    const grant = 'SYNTHETIC TEST FIXTURE. These authored test pixels permit local test copying, cropping and resizing. This is not a real supplier publication grant.';
    await writeFile(imagePath, bytes);
    await writeFile(rightsDocumentPath, grant);
    const imported = await importApprovedPhoto({
      mediaRoot: join(dir, 'registry'), enterpriseId: 'enterprise-01', pageId: 'product', assetId: 'synthetic-image-01',
      imagePath, rightsDocumentPath, alt: 'Synthetic test artwork', credit: 'Synthetic test art, not supplier photography',
      grantedBy: 'synthetic-test-operator', attestRights: true,
    });
    assert.equal(imported.publication, 'BLOCKED_PENDING_FINAL_REVIEW');
    const grantPath = join(tenant, 'grants', imported.descriptor.rights.grant_sha256 + '.bin');
    assert.equal(await readFile(grantPath, 'utf8'), grant);
    const options = {
      mediaPlan: planMedia(articles, [imported.descriptor], new Date().toISOString()),
      visualPlan, articles, articlesDir, enterpriseId: 'enterprise-01',
      mediaRoot: join(dir, 'registry'), aiGenerationAuthorized: false,
    };
    const result = await materializeEditionMedia(options);
    assert.equal(result.rights_photo_count, 1);
    assert.equal(result.ai_generated_count, 0);
    assert.equal(result.abstract_fallback_count, 1);
    assert.equal(result.publication, 'BLOCKED');
    assert.equal(sha256(await readFile(join(articlesDir, 'hero-product.png'))), result.images[0].sha256);
    assert.match(result.images[1].caption, /Conceptual artwork/);
    await assert.rejects(() => materializeEditionMedia({
      ...options, enterpriseId: 'different-company',
    }));
    await writeFile(grantPath, 'This grant has been replaced and its digest no longer matches the frozen descriptor.');
    await assert.rejects(() => materializeEditionMedia(options), (error) => error.code === 'APPROVED_MEDIA_GRANT_MISMATCH');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing image can invoke an explicitly authorized image provider without claiming it is photography', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-generated-'));
  try {
    const articlesDir = join(dir, 'out');
    await mkdir(articlesDir);
    const bytes = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: '#c7b1a2' } }).png().toBuffer();
    let calls = 0;
    const options = {
      mediaPlan: planMedia(articles, [], '2026-11-18T12:00:00Z'), visualPlan, articles, articlesDir,
      enterpriseId: 'enterprise-01', aiGenerationAuthorized: true, apiKey: 'stub-test-key', maxAiImages: 1,
      imageGenerator: async ({ prompt, model }) => {
        calls++;
        assert.match(prompt, /not a real product photo/i);
        return { bytes, prompt_sha256: sha256(Buffer.from(prompt)), model };
      },
    };
    const report = await materializeEditionMedia(options);
    assert.equal(calls, 1);
    assert.equal(report.ai_generated_count, 1);
    assert.equal(report.abstract_fallback_count, 1);
    assert.match(report.images[0].credit, /AI-generated editorial concept/);
    assert.equal(report.images[0].generation_model, 'gpt-image-2');
    const rerun = await materializeEditionMedia(options);
    assert.equal(calls, 1, 'same frozen prompt/model/tenant must not spend again');
    assert.equal(rerun.ai_cache_hit_count, 1);
    assert.equal(rerun.ai_provider_call_count, 0);
    assert.deepEqual(rerun.images, report.images);
    const cacheDir = join(dir, '.media-cache');
    const cacheFile = (await readdir(cacheDir)).find((name) => name.endsWith('.png'));
    await writeFile(join(cacheDir, cacheFile), 'tampered');
    await assert.rejects(() => materializeEditionMedia(options), (error) => error.code === 'MEDIA_CACHE_INVALID');
    assert.equal(calls, 1, 'corrupt receipt must fail closed instead of silently spending again');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('forged plan hashes and mismatched provider receipts cannot bless generated bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-binding-'));
  try {
    const articlesDir = join(dir, 'out');
    await mkdir(articlesDir);
    const mediaPlan = planMedia(articles, [], '2026-11-18T12:00:00Z');
    const options = { mediaPlan, visualPlan, articles, articlesDir, enterpriseId: 'enterprise-01' };
    await assert.rejects(() => materializeEditionMedia({ ...options, mediaPlan: { ...mediaPlan, plan_sha256: 'a'.repeat(64) } }),
      (error) => error.code === 'MEDIA_PLAN_INVALID');
    await assert.rejects(() => materializeEditionMedia({ ...options, aiGenerationAuthorized: true, apiKey: 'synthetic-test',
      imageGenerator: async () => ({ model: 'gpt-image-2', prompt_sha256: 'b'.repeat(64) }),
    }), (error) => error.code === 'MEDIA_GENERATION_RECEIPT_INVALID');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
