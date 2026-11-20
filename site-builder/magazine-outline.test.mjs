import test from 'node:test';
import assert from 'node:assert/strict';
import { planMagazineOutline } from './magazine-outline.mjs';

const compiled = (withProducts = true) => {
  const product = { slug: 'cat-companion', pageType: 'product-editorial', refs: ['enterprise-product-1'] };
  return {
    fingerprint: 'a'.repeat(64),
    site: { slug: 'sample-buyer-site', name: 'Example | Buyer Notes' },
    visualPlan: { direction: 'editorial' },
    articles: [
      { slug: 'supplier-profile', pageType: 'supplier-profile', refs: ['enterprise-company', 'website-1'] },
      ...(withProducts ? [product] : []),
      { slug: 'buyer-guide', pageType: 'buyer-guide', refs: [] },
    ],
    evidence: [
      { evidence_id: 'enterprise-company', publication_permission: 'internal-only', value: 'example' },
      { evidence_id: 'website-1', publication_permission: 'public-source-review-only', value: 'example' },
      ...(withProducts ? [{ evidence_id: 'enterprise-product-1', publication_permission: 'internal-only', value: 'example' }] : []),
    ],
  };
};
test('source-bound outline follows the editorial arc and is reproducible', () => {
  const a = planMagazineOutline(compiled());
  const b = planMagazineOutline(compiled());
  assert.deepEqual(a, b);
  assert.equal(a.chapters[0].layout, 'cover');
  assert.equal(a.chapters[1].layout, 'contents');
  assert.equal(a.chapters.at(-1).layout, 'sourcing');
  assert.equal(a.chapters.find(x => x.id === 'product-portfolio').article_ids[0], 'cat-companion');
  assert.match(a.outline_sha256, /^[0-9a-f]{64}$/);
  assert.equal(a.publication_status, 'private-review');
});
test('empty catalogue never fabricates a product gallery or craft story', () => {
  const plan = planMagazineOutline(compiled(false));
  assert.ok(!plan.chapters.some(x => x.layout === 'gallery' || x.layout === 'craft'));
  assert.ok(plan.chapters.some(x => x.id === 'source-notebook'));
});
test('broken evidence references fail closed', () => {
  const data = compiled();
  data.articles[0].refs.push('not-in-ledger');
  assert.throws(() => planMagazineOutline(data), /unknown evidence/);
});
test('duplicate article slugs fail closed', () => {
  const data = compiled();
  data.articles.push({slug:'supplier-profile',pageType:'product-editorial',refs:[]});
  assert.throws(() => planMagazineOutline(data), /unique source-backed articles/);
});
test('source changes invalidate the outline fingerprint', () => {
  const first = compiled();
  const second = compiled();
  second.fingerprint = 'b'.repeat(64);
  assert.notEqual(planMagazineOutline(first).outline_sha256, planMagazineOutline(second).outline_sha256);
});
test('unknown source identities and excessive product records fail closed', () => {
  const data = compiled();
  data.evidence[1].evidence_id = 'enterprise-company';
  assert.throws(() => planMagazineOutline(data), /unique evidence IDs/);
  const many = compiled();
  many.articles = [many.articles[0], ...Array.from({length:13},(_,i)=>({slug:'product-'+i,pageType:'product-editorial',refs:['enterprise-product-1']})),many.articles.at(-1)];
  assert.throws(() => planMagazineOutline(many), /bounded products/);
});
