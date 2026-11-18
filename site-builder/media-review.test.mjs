import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { assertReviewedMedia, mediaHash, mediaReviewBinding, mediaReviewReceipt } from './media-review.mjs';
import { verifyPublicationMedia } from '../scripts/prepare-media.mjs';
import { importApprovedPhoto } from './media-import.mjs';
import { planMedia } from './media-policy.mjs';
import { revokePublicationGrant } from './media-rights.mjs';

const page = { page_id: 'sample', path: '/materials/sample/', title: 'Synthetic material study' };
const assessment = { decision: 'pass', visual_quality: 5, contextual_fit: 5, authenticity: 5, issues: [] };
const credit = 'AI-generated concept illustration';
const caption = 'AI-generated concept illustration. It does not depict any supplier product or factory.';
const makeAsset = (bytes) => ({ page_id: page.page_id, kind: 'ai-generated', file: 'src/assets/concepts/sample.png',
  sha256: mediaHash(bytes), prompt: 'Synthetic test prompt', prompt_sha256: mediaHash('Synthetic test prompt'),
  generation_model: 'synthetic-fixture', generation_provider: 'synthetic-fixture', alt: 'Synthetic test art', credit, caption });
// This synthetic receipt is confined to unit tests, never written to the live
// registry or cited as a provider execution. It tests both accepted receipt formats.
const attachTestReceipt = (asset, method = 'interactive-vision') => ({ ...asset,
  review: mediaReviewReceipt({ binding: mediaReviewBinding({ page, asset }), assessment, method,
    reviewer: 'Synthetic contract fixture', model: 'synthetic-fixture', notes: 'Synthetic unit-test observation only.' }) });

test('review approval binds original bytes, prompt, page, model and disclosure; absent, rejected and fixture verdicts fail closed', () => {
  const bytes = Buffer.from('Synthetic bytes for pure binding validation');
  const asset = attachTestReceipt(makeAsset(bytes));
  assert.doesNotThrow(() => assertReviewedMedia({ page, asset, bytes }));
  assert.doesNotThrow(() => assertReviewedMedia({ page, asset: attachTestReceipt(makeAsset(bytes), 'openai-responses'), bytes }));
  assert.throws(() => assertReviewedMedia({ page, asset, bytes: Buffer.from('changed') }), /MEDIA_IMAGE_HASH_MISMATCH/);
  assert.throws(() => assertReviewedMedia({ page, asset: { ...asset, prompt: 'changed' }, bytes }), /MEDIA_PROMPT_HASH_MISMATCH/);
  for (const changed of [
    { prompt: 'changed', prompt_sha256: mediaHash('changed') },
    { generation_model: 'another-model' }, { alt: 'Another image meaning' },
    { caption: caption + ' Additional use.' },
  ]) assert.throws(() => assertReviewedMedia({ page, asset: { ...asset, ...changed }, bytes }), /MEDIA_REVIEW_STALE/);
  assert.throws(() => assertReviewedMedia({ page: { ...page, path: '/suppliers/sample/' }, asset, bytes }), /MEDIA_REVIEW_STALE/);
  assert.throws(() => assertReviewedMedia({ page, asset: { ...asset, review: null }, bytes }), /MEDIA_REVIEW_MISSING/);
  assert.throws(() => assertReviewedMedia({ page, asset: { ...asset, review: { ...asset.review, decision: 'reject' } }, bytes }), /MEDIA_REVIEW_REJECTED/);
  assert.throws(() => assertReviewedMedia({ page, asset: { ...asset, review: { ...asset.review, evidence_type: 'fixture' } }, bytes }), /MEDIA_REVIEW_EVIDENCE_INVALID/);
  assert.throws(() => assertReviewedMedia({ page, asset: { ...asset, caption: 'Actual supplier sample' }, bytes }), /MEDIA_DISCLOSURE_REQUIRED/);
  assert.throws(() => assertReviewedMedia({ page, asset: { ...asset, kind: 'abstract-fallback' }, bytes }), /MEDIA_FALLBACK_PREVIEW_ONLY/);
});

async function writePilot(root, asset, bytes) {
  for (const path of ['src/data', 'src/content/articles', 'src/assets/concepts', 'src/assets/licensed']) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, 'src/data/pilot.json'), JSON.stringify({ articles: [{ slug: 'sample', desk: 'materials' }] }));
  await writeFile(join(root, 'src/data/concept-media.json'), JSON.stringify({ version: 'test-fixture', assets: [asset] }));
  await writeFile(join(root, asset.file), bytes);
  const frontmatter = { title: page.title, desk: 'materials', hero: '../../' + asset.file.slice('src/'.length),
    heroAlt: asset.alt, heroCredit: asset.credit, heroCaption: asset.caption };
  await writeFile(join(root, 'src/content/articles/sample.md'), '---\n' + Object.entries(frontmatter).map(([key, value]) => key + ': ' + JSON.stringify(value)).join('\n') + '\n---\nSynthetic fixture.\n');
}

test('default publication preparation rejects valid replacement pixels even after their registry SHA is updated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-media-review-'));
  try {
    const bytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#556677' } }).png().toBuffer();
    const asset = attachTestReceipt(makeAsset(bytes));
    await writePilot(dir, asset, bytes);
    assert.equal((await verifyPublicationMedia({ projectRoot: dir })).assets, 1);
    const changed = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#112233' } }).png().toBuffer();
    await writePilot(dir, { ...asset, sha256: mediaHash(changed) }, changed);
    await assert.rejects(() => verifyPublicationMedia({ projectRoot: dir }), /MEDIA_REVIEW_STALE/);
    await writePilot(dir, { ...asset, review: undefined }, bytes);
    await assert.rejects(() => verifyPublicationMedia({ projectRoot: dir }), /MEDIA_REVIEW_MISSING/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('default licensed publication uses the same applicable, current grant gate as enterprise rendering', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pilot-licensed-review-'));
  try {
    const bytes = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#889aaa' } }).png().toBuffer();
    const imagePath = join(dir, 'synthetic-art.png');
    const rightsDocumentPath = join(dir, 'synthetic-grant.txt');
    await writeFile(imagePath, bytes);
    await writeFile(rightsDocumentPath, 'SYNTHETIC local test grant for authored pixels only. Commercial use and transformations within this test are allowed. Not supplier permission.');
    const mediaRoot = join(dir, 'private');
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const imported = await importApprovedPhoto({ mediaRoot, enterpriseId: 'test-enterprise', pageId: 'sample', assetId: 'test-sample', imagePath, rightsDocumentPath,
      alt: 'Synthetic authored pixels', credit: 'Synthetic test image, used with test permission', grantedBy: 'test-operator', attestRights: true, attestCommercialUse: true, expiresAt });
    const selection = planMedia([{ slug: 'sample', title: page.title }], [imported.descriptor]).selections[0];
    const asset = attachTestReceipt({ ...selection, kind: 'licensed-photo', file: 'src/assets/licensed/sample.png', sha256: mediaHash(bytes), rights_expires_at: selection.expires_at,
      caption: 'Licensed test image. This is a synthetic fixture, not a supplier photo.' });
    await writePilot(dir, asset, bytes);
    assert.equal((await verifyPublicationMedia({ projectRoot: dir, mediaRoot })).assets, 1);
    const unrelated = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#112233' } }).png().toBuffer();
    const unrelatedAsset = attachTestReceipt({ ...asset, sha256: mediaHash(unrelated) });
    await writePilot(dir, unrelatedAsset, unrelated);
    await assert.rejects(() => verifyPublicationMedia({ projectRoot: dir, mediaRoot }), /MEDIA_LICENSED_DERIVATION_MISMATCH/);
    await writePilot(dir, asset, bytes);
    await assert.rejects(() => verifyPublicationMedia({ projectRoot: dir, mediaRoot, asOf: new Date(Date.now() + 120_000).toISOString() }), /APPROVED_MEDIA_RIGHTS_INVALID_OR_EXPIRED/);
    await revokePublicationGrant({ mediaRoot, enterpriseId: 'test-enterprise', grantSha256: selection.grant_sha256, revokedBy: 'test-operator', reason: 'Synthetic rights withdrawal' });
    await assert.rejects(() => verifyPublicationMedia({ projectRoot: dir, mediaRoot }), /APPROVED_MEDIA_RIGHTS_REVOKED/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
