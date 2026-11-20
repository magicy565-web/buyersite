import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { reviewBuiltSite, reviewScreenshots, reviewMediaAsset, VisualReviewError } from './visual-review.mjs';
import { planMedia } from './media-policy.mjs';
import { assertEditionVisualReview, assertMediaReview, mediaHash, mediaReviewBinding } from './media-review.mjs';

const verdict = {
  decision: 'pass', editorial_quality: 5, hierarchy: 4,
  mobile_readability: 5, authenticity: 5, issues: [],
};

test('review is blocked until both consent and credentials are present', async () => {
  const result = await reviewBuiltSite({ authorized: false, apiKey: 'test', artifactSha256: 'a'.repeat(64) });
  assert.equal(result.status, 'PENDING_CONFIGURATION');
  assert.equal(result.publication, 'BLOCKED');
  assert.equal(result.human_approval_required, false);
  assert.equal((await reviewBuiltSite({ authorized: 'true', apiKey: 'test' })).status, 'PENDING_CONFIGURATION');
});

test('injected captures cover every page and preserve full-height mobile readability', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'visual-review-'));
  try {
    const root = join(dir, 'source');
    await mkdir(root);
    await writeFile(join(root, 'pages.json'), JSON.stringify([
      { page_id: 'home', path: '/', page_type: 'home', title: 'Magazine' },
      { page_id: 'sample', path: '/products/sample/', page_type: 'product-editorial', title: 'Sample' },
      { page_id: 'second', path: '/products/second/', page_type: 'product-editorial', title: 'Second product' },
      { page_id: 'guide', path: '/guides/guide/', page_type: 'buyer-guide', title: 'Buying guide' },
      { page_id: 'supplier', path: '/suppliers/supplier/', page_type: 'supplier-profile', title: 'Supplier' },
    ]));
    const bytes = await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#b9b6ac' } }).png().toBuffer();
    const articles = ['sample', 'second', 'guide', 'supplier'].map((slug) => ({ slug, title: slug }));
    const plan = planMedia(articles);
    await writeFile(join(root, 'media-plan.json'), JSON.stringify(plan));
    await mkdir(join(root, 'articles'));
    const images = articles.map(({ slug }) => ({ page_id: slug, kind: 'ai-generated', filename: 'hero-' + slug + '.png', sha256: mediaHash(bytes), prompt: 'Synthetic test prompt', prompt_sha256: mediaHash('Synthetic test prompt'), generation_model: 'synthetic-fixture', generation_provider: 'synthetic-fixture', alt: 'Synthetic image', caption: 'Conceptual artwork. Not a depiction of any supplier product.', credit: 'AI-generated synthetic fixture' }));
    for (const image of images) await writeFile(join(root, 'articles', image.filename), bytes);
    const mediaReport = { images, plan_sha256: plan.plan_sha256 };
    await writeFile(join(root, 'media-report.json'), JSON.stringify(mediaReport));
    const sourceFingerprint = 'f'.repeat(64);
    const outlineSha256 = 'a'.repeat(64);
    await writeFile(join(root, 'receipt.json'), JSON.stringify({ fingerprint: sourceFingerprint, enterprise_id: 'synthetic-enterprise' }));
    await writeFile(join(root, 'magazine-outline.json'), JSON.stringify({ outline_sha256: outlineSha256 }));
    const sourceArticles = articles.map(({slug}) => ({
      id: slug, pageType: slug === 'guide' ? 'buyer-guide' : slug === 'supplier' ? 'supplier-profile' : 'product-editorial',
      title: slug, deck: 'Synthetic source-backed article.', evidenceRefs: slug === 'supplier' ? ['website-fact'] : [],
    }));
    const issue = {
      schemaVersion: '1.0.0', id: 'synthetic-issue', brand: 'Synthetic Magazine',
      title: 'Synthetic Magazine Issue', deck: 'Private visual-review fixture.',
      publicationStatus: 'private-review', visualProfile: 'editorial',
      sourceFingerprint, outlineSha256, mediaPlanSha256: plan.plan_sha256,
      mediaReportSha256: mediaHash(JSON.stringify(mediaReport)), sourceArticles,
      evidence: [{ id: 'website-fact', claim: 'Website statement', value: 'Synthetic source text.',
        status: 'supplier-stated', permission: 'public-source-review-only',
        sourceUrl: 'https://example.test/about', capturedAt: '2026-11-20T00:00:00.000Z' }],
      assets: images.map(image => ({
        id: image.page_id, articleId: image.page_id, filename: image.filename, sha256: image.sha256,
        kind: image.kind, promptSha256: image.prompt_sha256, generationModel: image.generation_model,
        generationProvider: image.generation_provider, alt: image.alt, credit: image.credit,
        caption: image.caption, reviewStatus: 'required',
      })),
      spreads: [
        { id: 'cover', kind: 'cover', kicker: 'PRIVATE ISSUE', title: 'Synthetic Magazine',
          deck: 'A private visual review.', assetIds: ['supplier'], evidenceRefs: ['website-fact'] },
        { id: 'contents', kind: 'contents', kicker: 'THE ISSUE', title: 'Contents',
          deck: 'A short reading path.', assetIds: [], evidenceRefs: [],
          chapters: [{number:'01',title:'Story',target:'story'},{number:'02',title:'Source notes',target:'notes'},{number:'03',title:'Sourcing',target:'sourcing'}] },
        { id: 'story', kind: 'story', kicker: '01 · STORY', title: 'Supplier story',
          deck: 'Source-bound story.', assetIds: [], articleId: 'supplier', evidenceRefs: ['website-fact'],
          sections: [{heading:'What is stated',body:'Synthetic source text.'}] },
        { id: 'notes', kind: 'notes', kicker: '02 · NOTES', title: 'Buyer notes',
          deck: 'A record of source facts.', assetIds: [], evidenceRefs: ['website-fact'],
          questions: [{title:'Verification',body:'Confirm this statement directly.'}] },
        { id: 'sourcing', kind: 'sourcing', kicker: '03 · NEXT STEP', title: 'Prepare an enquiry',
          deck: 'Prepare a local draft.', assetIds: ['guide'], articleId: 'guide', evidenceRefs: [] },
      ],
    };
    await writeFile(join(root, 'magazine-issue.json'), JSON.stringify(issue));
    const mobile = await sharp({ create: { width: 390, height: 5200, channels: 3, background: '#b9b6ac' } }).png().toBuffer();
    const reviewed = [];
    const result = await reviewBuiltSite({
      authorized: true, apiKey: 'synthetic-test', artifactDir: dir, jobDir: dir,
      sourceRoot: root, artifactSha256: 'c'.repeat(64),
      captureFn: async () => [{ name: 'desktop', bytes }, { name: 'mobile', bytes: mobile }],
      reviewFn: async ({ screenshots, page }) => {
        reviewed.push(page.page_id);
        const mobileTiles = screenshots.filter((shot) => shot.viewport === 'mobile');
        assert.equal(mobileTiles.length, 4);
        assert.ok(mobileTiles.every((shot) => shot.width === 390));
        assert.equal(mobileTiles.at(-1).y + mobileTiles.at(-1).height, 5200);
        return verdict;
      },
    });
    assert.equal(result.status, 'PASS_RECOMMENDED');
    assert.equal(result.publication, 'BLOCKED');
    assert.equal(result.pages.length, 6);
    assert.equal(result.pages[0].screenshots.length, 5);
    assert.equal(result.evidence_type, 'fixture');
    await assert.rejects(() => assertEditionVisualReview({ review: result, sourceRoot: root, artifactSha256: 'c'.repeat(64), jobDir: dir }), /EDITION_REVIEW_REQUIRED/);
    // This copied observation is solely a synthetic contract fixture, never saved as production approval.
    const observedFixture = { ...result, evidence_type: 'observed', review_method: 'interactive-vision' };
    assert.equal((await assertEditionVisualReview({ review: observedFixture, sourceRoot: root, artifactSha256: 'c'.repeat(64), jobDir: dir })).media_review_complete, true);
    const reportFile = join(root, 'media-report.json');
    const originalReport = await readFile(reportFile, 'utf8');
    const changed = JSON.parse(originalReport);
    changed.images[0].prompt = 'Changed synthetic prompt'; changed.images[0].prompt_sha256 = mediaHash(changed.images[0].prompt);
    await writeFile(reportFile, JSON.stringify(changed));
    await assert.rejects(() => assertEditionVisualReview({ review: observedFixture, sourceRoot: root, artifactSha256: 'c'.repeat(64), jobDir: dir }), /EDITION_REVIEW_STALE/);
    await writeFile(reportFile, originalReport);
    assert.deepEqual(reviewed, ['home', 'sample', 'second', 'guide', 'supplier', 'magazine-issue']);
    assert.deepEqual(result.coverage, { expected_pages: 6, reviewed_pages: 6, complete: true });
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
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(verdict) }] }] });
  };
  const result = await reviewScreenshots({
    screenshots: [{ bytes: tiny }, { bytes: tiny }], apiKey: 'synthetic-test',
    page: { page_id: 'sample', title: 'Page' }, media: { kind: 'abstract-fallback' }, fetchImpl,
  });
  assert.equal(result.decision, 'pass');
  await assert.rejects(() => reviewScreenshots({
    screenshots: [{ bytes: tiny }, { bytes: tiny }], apiKey: 'synthetic-test',
    fetchImpl: async () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: '{\"decision\":\"pass\"}' }] }] }),
  }), VisualReviewError);
});

test('empty or unsafe manifests and missing source files cannot produce a vacuous PASS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'visual-empty-'));
  try {
    const options = { authorized: true, apiKey: 'synthetic-test', artifactDir: dir, jobDir: dir,
      sourceRoot: dir, artifactSha256: 'c'.repeat(64),
      captureFn: () => { throw Error('must not capture'); },
    };
    assert.equal((await reviewBuiltSite(options)).status, 'REVIEW_ERROR');
    await writeFile(join(dir, 'pages.json'), '[]');
    await writeFile(join(dir, 'media-report.json'), '{"images":[]}');
    assert.equal((await reviewBuiltSite(options)).status, 'REVIEW_ERROR');
    await writeFile(join(dir, 'pages.json'), JSON.stringify([{ page_id: '../outside', path: '/', page_type: 'home' }]));
    assert.equal((await reviewBuiltSite(options)).status, 'REVIEW_ERROR');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('vision verdicts with null issues and unknown fields fail closed', async () => {
  const png = await sharp({ create: { width: 390, height: 400, channels: 3, background: '#555555' } }).png().toBuffer();
  for (const value of [{ ...verdict, issues: [null] }, { ...verdict, publication: 'approved' }]) {
    await assert.rejects(() => reviewScreenshots({
      screenshots: [{ bytes: png }, { bytes: png }], apiKey: 'synthetic-test',
      fetchImpl: async () => Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify(value) }] }] }),
    }), (error) => error.code === 'VISUAL_REVIEW_INVALID');
  }
});

test('single-image AI adapter submits pixels and returns a bound assessment without disguising injected transport as a live provider', async () => {
  const bytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#556677' } }).png().toBuffer();
  const page = { page_id: 'sample', path: '/products/sample/', title: 'Synthetic concept study' };
  const asset = { page_id: 'sample', kind: 'ai-generated', sha256: mediaHash(bytes), prompt: 'Synthetic prompt', prompt_sha256: mediaHash('Synthetic prompt'),
    generation_model: 'synthetic-fixture', generation_provider: 'synthetic-fixture', alt: 'Synthetic image', credit: 'AI-generated test concept', caption: 'Conceptual artwork. Not a depiction of any supplier product.' };
  const review = await reviewMediaAsset({ page, asset, bytes, apiKey: 'synthetic-test', fetchImpl: async (url, request) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const payload = JSON.parse(request.body);
    assert.equal(payload.input[0].content.filter((item) => item.type === 'input_image').length, 1);
    assert.ok(payload.text.format.schema.required.includes('contextual_fit'));
    return Response.json({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ decision: 'pass', visual_quality: 5, contextual_fit: 5, authenticity: 5, issues: [] }) }] }] });
  } });
  assert.equal(review.decision, 'pass');
  assert.equal(review.evidence_type, 'fixture');
  assert.equal(review.human_approval_required, false);
  assert.throws(() => assertMediaReview({ binding: mediaReviewBinding({ page, asset }), review }), /MEDIA_REVIEW_EVIDENCE_INVALID/);
});
