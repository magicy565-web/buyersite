import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseEditorialDirection, planEditorialVisuals, renderEditorialArtwork } from './visual-director.mjs';

test('category-led visual profiles are deterministic and bounded', () => {
  assert.equal(chooseEditorialDirection(['Rayon fabrics'], 'Mill'), 'atelier');
  assert.equal(chooseEditorialDirection(['Industrial components'], 'Works'), 'industrial');
  assert.equal(chooseEditorialDirection([], 'Other Trading'), 'editorial');
});

test('every article gets a distinct, rights-safe art asset', () => {
  const input = {
    companyName: 'Example Textile', categories: ['Textiles'],
    articles: [{ slug: 'sample', pageType: 'product-editorial' }, { slug: 'supplier', pageType: 'supplier-profile' }, { slug: 'guide', pageType: 'buyer-guide' }],
  };
  const one = planEditorialVisuals(input);
  assert.deepEqual(one, planEditorialVisuals(input));
  assert.equal(one.direction, 'atelier');
  assert.equal(new Set(one.images.map((image) => image.asset)).size, 3);
  assert.ok(one.images.every((image) => image.source === 'original-abstract-illustration'));
  const svg = one.images.map((item) => renderEditorialArtwork({ direction: one.direction, pageId: item.page_id, sequence: item.sequence, composition: item.composition }));
  assert.equal(new Set(svg).size, 3);
  assert.ok(svg.every((value) => value.startsWith('<svg') && !value.includes('<script')));
});

test('artwork inputs cannot inject elements or filesystem paths', () => {
  assert.throws(() => planEditorialVisuals({ articles: [{ slug: '../secret' }] }), /path-safe/);
  assert.throws(() => planEditorialVisuals({ articles: [{ slug: 'a' }, { slug: 'a' }] }), /unique/);
  assert.throws(() => renderEditorialArtwork({ direction: 'custom-css', pageId: 'safe' }), /Unknown/);
  assert.throws(() => renderEditorialArtwork({ direction: 'atelier', pageId: '<script>' }), /Invalid/);
});
