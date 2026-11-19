import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv/dist/2020.js';
import { planEditionLayout, validateLayoutPlan, layoutInputsFromPack } from './layout-planner.mjs';

const schema = JSON.parse(readFileSync(new URL('../docs/v2/schemas/layout-plan.schema.json', import.meta.url), 'utf8'));
const validateSchema = new Ajv({ strict: false }).compile(schema);

const page = (page_id, page_type, evidence_refs = []) => ({ page_id, page_type, evidence_refs });
const edition = ({ products = 1, kind = 'ai-generated', values = ['100% wool', '140 cm', '800 g/m'], direction = 'atelier', name = 'Material Notes' } = {}) => {
  const pages = [page('home', 'home'), page('supplier', 'supplier-profile', ['s1']), page('guide', 'buyer-guide')];
  const evidence = [{ evidence_id: 's1', value: 'Manteigas, Portugal' }];
  for (let i = 0; i < products; i++) {
    const refs = values.map((_, j) => `p${i}-${j}`);
    values.forEach((value, j) => evidence.push({ evidence_id: `p${i}-${j}`, value }));
    pages.push(page('product-' + i, 'product-editorial', refs));
  }
  const media = pages.filter((p) => p.page_type !== 'home').map((p) => ({ page_id: p.page_id, kind }));
  return { pages, evidence, media, siteName: name, direction };
};

test('the pilot shape plans the Golden Reference: prestige, split cover, picture-led product', () => {
  const plan = planEditionLayout(edition());
  assert.equal(plan.design_family, 'editorial-prestige');
  assert.equal(plan.home.cover, 'split');
  assert.equal(plan.pages['product-0'].hero, 'split');
  assert.equal(plan.pages['product-0'].ledger, 'figures');
  assert.equal(plan.pages.supplier.hero, 'split-reverse');
});

test('each scenario gets a structurally different plan, not a different palette', () => {
  const plans = {
    prestige: planEditionLayout(edition()),
    journal: planEditionLayout(edition({ kind: 'abstract-fallback', values: ['A woven cotton canvas for bags'] })),
    dossier: planEditionLayout(edition({ kind: 'abstract-fallback', direction: 'industrial' })),
    catalog: planEditionLayout(edition({ products: 7, kind: 'abstract-fallback' })),
    sparse: planEditionLayout(edition({ products: 0, kind: 'abstract-fallback' })),
  };
  assert.deepEqual(Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, p.design_family])), {
    prestige: 'editorial-prestige', journal: 'editorial-journal', dossier: 'technical-dossier', catalog: 'catalog-index', sparse: 'sparse-brief',
  });
  const orders = new Set(Object.values(plans).map((p) => p.home.blocks.join('>')));
  assert.equal(orders.size, 5, 'every family orders the home page differently');
  assert.equal(plans.catalog.home.blocks[0], 'catalog');
  assert.equal(plans.dossier.home.blocks[0], 'lead-ledger');
});

test('abstract fallback art never leads a cover or a page', () => {
  for (const options of [{ kind: 'abstract-fallback' }, { kind: 'abstract-fallback', products: 7 }, { kind: 'abstract-fallback', products: 0 }]) {
    const plan = planEditionLayout(edition(options));
    assert.equal(plan.home.cover, 'typographic');
    assert.ok(Object.values(plan.pages).every((p) => p.hero === 'marginal' && p.show_media === false));
  }
});

test('an AI concept that failed review is treated as no usable media', () => {
  const input = edition();
  input.media = input.media.map((m) => ({ ...m, review_decision: 'fail' }));
  assert.equal(planEditionLayout(input).home.cover, 'typographic');
});

test('three numeric facts are not a technical dossier; dense numeric specifications are', () => {
  assert.equal(planEditionLayout(edition()).design_family, 'editorial-prestige');
  const dense = edition({ values: ['12 mm', '40 bar', '230 V', '50 Hz', '3 kg', '120 °C'] });
  assert.equal(planEditionLayout(dense).design_family, 'technical-dossier');
});

test('plans are deterministic, schema-valid and self-verifying', () => {
  const a = planEditionLayout(edition({ products: 3 }));
  const b = planEditionLayout(edition({ products: 3 }));
  assert.equal(a.plan_sha256, b.plan_sha256);
  assert.ok(validateSchema(a), JSON.stringify(validateSchema.errors));
  assert.doesNotThrow(() => validateLayoutPlan(a, ['supplier', 'guide', 'product-0', 'product-1', 'product-2']));
});

test('validation fails closed on unknown blocks, layouts, missing pages and tampering', () => {
  const plan = planEditionLayout(edition());
  assert.throws(() => validateLayoutPlan({ ...plan, home: { ...plan.home, blocks: ['index', 'carousel'] } }), /home.blocks/);
  assert.throws(() => validateLayoutPlan({ ...plan, pages: { ...plan.pages, supplier: { ...plan.pages.supplier, hero: 'html' } } }), /hero/);
  assert.throws(() => validateLayoutPlan(plan, ['not-a-page']), /missing page/);
  assert.throws(() => validateLayoutPlan({ ...plan, design_family: 'editorial-journal' }), /plan_sha256/);
});

test('pack adapter keeps only the signals the planner may use', () => {
  const inputs = layoutInputsFromPack({
    pages: [{ page_id: 'x', page_type: 'product-editorial', evidence_refs: ['e'], title: 'secret title' }],
    evidence: [{ evidence_id: 'e', value: '1 m', source_quote: 'private quote' }],
    mediaReport: { images: [{ page_id: 'x', kind: 'licensed-photo', prompt: 'p', sha256: 'h' }] },
    site: { name: 'N' },
    visualPlan: { direction: 'editorial' },
  });
  assert.deepEqual(inputs.pages[0], { page_id: 'x', page_type: 'product-editorial', evidence_refs: ['e'] });
  assert.deepEqual(inputs.evidence[0], { evidence_id: 'e', value: '1 m' });
  assert.deepEqual(inputs.media[0], { page_id: 'x', kind: 'licensed-photo' });
});
