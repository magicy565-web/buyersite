import test from 'node:test';
import assert from 'node:assert/strict';
import { planMedia, normalizeMediaAssets, MediaPolicyError } from './media-policy.mjs';

const hash = 'a'.repeat(64);
const grant = 'b'.repeat(64);
const fixed = '2026-11-18T12:00:00Z';
const article = [{ slug: 'product', title: 'Woven Textiles', pageType: 'product-editorial' }, { slug: 'supplier', title: 'Supplier', pageType: 'supplier-profile' }];
const photo = (overrides = {}) => ({
  asset_id: 'approved-product-01', page_id: 'product', sha256: hash, alt: 'Woven cotton sample',
  credit: 'Supplier photo, used with permission',
  rights: { status: 'approved-public', scope: 'buyer-magazine-site', grant_sha256: grant, granted_by: 'editor-1', approved_at: '2026-11-15T00:00:00Z', allow_resize: true, allow_crop: true, ...overrides },
});

test('selects the licensed photo only for its bound page and requests generation for other pages', () => {
  const plan = planMedia(article, [photo()], fixed);
  assert.equal(plan.approved_count, 1);
  assert.equal(plan.missing_count, 1);
  assert.equal(plan.selections[0].media_kind, 'licensed-photo');
  assert.equal(plan.selections[0].grant_sha256, grant);
  assert.equal(plan.selections[1].media_kind, 'generation-requested');
  assert.deepEqual(plan, planMedia(article, [photo()], fixed));
});

test('unapproved or expired media cannot be published as a licensed photograph', () => {
  for (const changes of [
    { status: 'review-only' }, { grant_sha256: null }, { allow_crop: false },
    { expires_at: '2026-11-17T00:00:00Z' },
  ]) {
    const plan = planMedia(article, [photo(changes)], fixed);
    assert.equal(plan.approved_count, 0);
    assert.equal(plan.selections[0].fallback_reason, 'NO_PUBLICATION_GRANT');
  }
});

test('invalid media identities and cross-page references fail closed', () => {
  assert.throws(() => normalizeMediaAssets([photo(), photo()]), MediaPolicyError);
  assert.throws(() => planMedia(article, [{ ...photo(), page_id: '../evil' }], fixed), MediaPolicyError);
  assert.throws(() => planMedia(article, [{ ...photo(), page_id: 'not-on-site' }], fixed), MediaPolicyError);
  assert.throws(() => planMedia(article, [{ ...photo(), sha256: 'fake' }], fixed), MediaPolicyError);
  assert.throws(() => planMedia(article, [{ ...photo(), alt: '  ' }], fixed), MediaPolicyError);
});

test('a licensed photo may be reused on another explicitly bound page', () => {
  const plan = planMedia(article, [photo(), { ...photo(), asset_id: 'supplier-image', page_id: 'supplier' }], fixed);
  assert.equal(plan.approved_count, 2);
  assert.equal(plan.missing_count, 0);
});
