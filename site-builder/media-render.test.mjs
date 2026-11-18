import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { planMedia } from './media-policy.mjs';
import { planEditorialVisuals } from './visual-director.mjs';
import { materializeEditionMedia } from './media-render.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const articles = [
  { slug: 'product', title: 'Cotton Canvas', pageType: 'product-editorial' },
  { slug: 'guide', title: 'Buying Guide', pageType: 'buyer-guide' },
];
const visualPlan = planEditorialVisuals({ companyName: 'Textile Mill', categories: ['Textiles'], articles });
const approved = (sha) => ({
  asset_id: 'image-01', page_id: 'product', sha256: sha, alt: 'Cotton fabric closeup',
  credit: 'Photo by approved enterprise uploader',
  rights: { status: 'approved-public', scope: 'buyer-magazine-site', grant_sha256: 'f'.repeat(64), granted_by: 'owner',
    approved_at: '2026-11-17T00:00:00Z', allow_resize: true, allow_crop: true },
});
test('licensed media comes from tenant scoped sha storage, unlicensed page becomes abstract art', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-acceptance-'));
  try {
    const tenant = join(dir, 'registry', 'enterprise-01');
    const articlesDir = join(dir, 'out');
    await mkdir(tenant, { recursive: true });
    await mkdir(articlesDir);
    const bytes = await sharp({ create: { width: 1200, height: 900, channels: 3, background: '#acb8a0' } }).png().toBuffer();
    const digest = sha256(bytes);
    await writeFile(join(tenant, digest + '.bin'), bytes);
    const result = await materializeEditionMedia({
      mediaPlan: planMedia(articles, [approved(digest)], '2026-11-18T12:00:00Z'),
      visualPlan, articles, articlesDir, enterpriseId: 'enterprise-01',
      mediaRoot: join(dir, 'registry'), aiGenerationAuthorized: false,
    });
    assert.equal(result.rights_photo_count, 1);
    assert.equal(result.ai_generated_count, 0);
    assert.equal(result.abstract_fallback_count, 1);
    assert.equal(result.publication, 'BLOCKED');
    assert.equal(sha256(await readFile(join(articlesDir, 'hero-product.png'))), result.images[0].sha256);
    assert.match(result.images[1].caption, /Conceptual artwork/);
    await assert.rejects(() => materializeEditionMedia({
      mediaPlan: planMedia(articles, [approved(digest)], '2026-11-18T12:00:00Z'),
      visualPlan, articles, articlesDir, enterpriseId: 'different-company',
      mediaRoot: join(dir, 'registry'), aiGenerationAuthorized: false,
    }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing image can invoke an explicitly authorized image provider without claiming it is photography', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'media-generated-'));
  try {
    const articlesDir = join(dir, 'out');
    await mkdir(articlesDir);
    const bytes = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: '#c7b1a2' } }).png().toBuffer();
    let calls = 0;
    const report = await materializeEditionMedia({
      mediaPlan: planMedia(articles, [], '2026-11-18T12:00:00Z'), visualPlan, articles, articlesDir,
      enterpriseId: 'enterprise-01', aiGenerationAuthorized: true, apiKey: 'stub-test-key', maxAiImages: 1,
      imageGenerator: async ({ prompt }) => {
        calls++;
        assert.match(prompt, /not a real product photo/i);
        return { bytes, prompt_sha256: sha256(Buffer.from(prompt)), model: 'test-model' };
      },
    });
    assert.equal(calls, 1);
    assert.equal(report.ai_generated_count, 1);
    assert.equal(report.abstract_fallback_count, 1);
    assert.match(report.images[0].credit, /AI-generated editorial concept/);
    assert.equal(report.images[0].generation_model, 'test-model');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
