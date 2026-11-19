// Layout planner: the deterministic half of the Visual Director.
//
// It reads what an edition actually has -- how many products, how dense and how numeric its
// evidence is, what kind of media it may show, how long its name is, which category profile the
// visual director chose -- and returns a layout plan: a design family, the order of blocks on the
// home page, and the composition of every article page. The plan names only whitelisted blocks
// and layouts, so the renderer can trust it; it never contains markup, CSS or copy.
//
// A model may later propose a plan (see docs/v2/ARCHITECTURE.md). It must pass
// validateLayoutPlan(), and the facts it is allowed to rely on are the same signals below.
import { createHash } from 'node:crypto';

export const LAYOUT_SCHEMA_VERSION = '2.0.0';
export const DESIGN_FAMILIES = Object.freeze([
  'editorial-prestige',
  'editorial-journal',
  'technical-dossier',
  'catalog-index',
  'sparse-brief',
]);
export const COVER_LAYOUTS = Object.freeze(['split', 'immersive', 'typographic']);
export const HOME_BLOCKS = Object.freeze(['index', 'lead-ledger', 'supplier', 'products', 'catalog', 'questions', 'reading', 'trust']);
export const HERO_LAYOUTS = Object.freeze(['split', 'split-reverse', 'text-led', 'marginal']);
export const LEDGER_VARIANTS = Object.freeze(['figures', 'table']);

// Media the edition may show, ranked by how much page it can carry. Abstract fallbacks are
// provenance-honest but say nothing about the subject, so they never lead a cover.
const MEDIA_STRENGTH = { 'licensed-photo': 3, 'ai-generated': 2, 'abstract-fallback': 0 };

const figureLike = (value) => /^\d[\d.,]*(?:\s?(?:%|[A-Za-z]{1,3}(?:\/[A-Za-z]{1,3})?)(?![A-Za-z]))?/.test(String(value ?? ''));

/** Measurable signals. Everything the plan decides is derived from these and recorded with it. */
export function layoutSignals({ pages = [], evidence = [], media = [], siteName = '', direction = 'editorial' }) {
  const articles = pages.filter((page) => page.page_type !== 'home');
  const products = articles.filter((page) => page.page_type === 'product-editorial');
  const strength = (pageId) => {
    const item = media.find((entry) => entry.page_id === pageId);
    if (!item) return 0;
    if (item.kind === 'ai-generated' && item.review_decision && item.review_decision !== 'pass') return 0;
    return MEDIA_STRENGTH[item.kind] ?? 0;
  };
  const byId = new Map(evidence.map((item) => [item.evidence_id, item]));
  const factsFor = (page) => (page.evidence_refs ?? []).map((id) => byId.get(id)).filter(Boolean);
  const productFacts = products.flatMap(factsFor);
  const numeric = productFacts.filter((item) => figureLike(item.value) && String(item.value).length <= 64).length;
  const strengths = articles.map((page) => strength(page.page_id));
  return {
    product_count: products.length,
    article_count: articles.length,
    evidence_count: evidence.length,
    facts_per_product: products.length ? +(productFacts.length / products.length).toFixed(2) : 0,
    numeric_fact_ratio: productFacts.length ? +(numeric / productFacts.length).toFixed(2) : 0,
    media_strength_max: strengths.length ? Math.max(...strengths) : 0,
    media_strength_min: strengths.length ? Math.min(...strengths) : 0,
    name_length: String(siteName).length,
    category_direction: direction,
  };
}

/** Pure, deterministic: identical inputs always produce an identical plan. */
export function planEditionLayout(input) {
  const signals = layoutSignals(input);
  const { pages = [], evidence = [], media = [] } = input;
  const strongMedia = signals.media_strength_max >= 2;
  const rationale = [];

  let family;
  if (signals.product_count === 0) {
    family = 'sparse-brief';
    rationale.push('No product records: lead with what the company states and what a buyer must establish.');
  } else if (signals.product_count >= 4) {
    family = 'catalog-index';
    rationale.push(`${signals.product_count} products: a scannable catalogue index replaces single feature stories.`);
  } else if (signals.category_direction === 'industrial' || (signals.numeric_fact_ratio >= 0.6 && signals.facts_per_product >= 6)) {
    family = 'technical-dossier';
    rationale.push('Technical category or dense numeric specifications: specification-first pages, tabular ledgers, type-led cover.');
  } else if (strongMedia) {
    family = 'editorial-prestige';
    rationale.push('Reviewed media strong enough to lead: picture-led cover and product pages.');
  } else {
    family = 'editorial-journal';
    rationale.push('Material-led category without usable pictures: a typographic journal; artwork kept marginal.');
  }
  if (!strongMedia) rationale.push('Only abstract fallback artwork is available: no picture leads a cover or a page.');
  if (signals.name_length > 28) rationale.push('Long publication name: the masthead steps down a size.');

  const cover = strongMedia && (family === 'editorial-prestige' || family === 'catalog-index') ? 'split' : 'typographic';
  const homeBlocks = {
    'editorial-prestige': ['index', 'lead-ledger', 'supplier', 'products', 'questions', 'reading', 'trust'],
    'editorial-journal': ['index', 'lead-ledger', 'products', 'supplier', 'questions', 'reading', 'trust'],
    'technical-dossier': ['lead-ledger', 'index', 'products', 'supplier', 'questions', 'reading', 'trust'],
    'catalog-index': ['catalog', 'supplier', 'questions', 'reading', 'trust'],
    'sparse-brief': ['lead-ledger', 'questions', 'index', 'reading', 'trust'],
  }[family];

  const byId = new Map(evidence.map((item) => [item.evidence_id, item]));
  const mediaKind = (pageId) => media.find((entry) => entry.page_id === pageId)?.kind ?? 'abstract-fallback';
  const pagePlans = {};
  for (const page of pages.filter((entry) => entry.page_type !== 'home')) {
    const facts = (page.evidence_refs ?? []).map((id) => byId.get(id)).filter(Boolean);
    const numericShare = facts.length ? facts.filter((item) => figureLike(item.value) && String(item.value).length <= 64).length / facts.length : 0;
    const pageStrong = (MEDIA_STRENGTH[mediaKind(page.page_id)] ?? 0) >= 2;
    let hero;
    if (!pageStrong) hero = 'marginal';
    else if (page.page_type === 'supplier-profile') hero = 'split-reverse';
    else if (page.page_type === 'buyer-guide') hero = 'text-led';
    else hero = family === 'technical-dossier' ? 'text-led' : 'split';
    pagePlans[page.page_id] = {
      hero,
      ledger: page.page_type === 'product-editorial' && numericShare >= 0.5 && facts.length <= 6 ? 'figures' : 'table',
      show_media: pageStrong,
    };
  }
  const plan = {
    schema_version: LAYOUT_SCHEMA_VERSION,
    design_family: family,
    signals,
    rationale,
    home: { cover, blocks: homeBlocks, show_media: strongMedia },
    pages: pagePlans,
  };
  return { ...plan, plan_sha256: createHash('sha256').update(JSON.stringify(plan)).digest('hex') };
}

/** Fail closed: an unknown family, block or layout is an error, never a silent default. */
export function validateLayoutPlan(plan, pageIds = []) {
  const fail = (why) => {
    throw new TypeError('LAYOUT_PLAN_INVALID: ' + why);
  };
  if (!plan || plan.schema_version !== LAYOUT_SCHEMA_VERSION) fail('schema_version');
  if (!DESIGN_FAMILIES.includes(plan.design_family)) fail('design_family');
  if (!COVER_LAYOUTS.includes(plan.home?.cover)) fail('home.cover');
  if (!Array.isArray(plan.home?.blocks) || plan.home.blocks.some((block) => !HOME_BLOCKS.includes(block))) fail('home.blocks');
  if (new Set(plan.home.blocks).size !== plan.home.blocks.length) fail('home.blocks duplicate');
  for (const [id, page] of Object.entries(plan.pages ?? {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail('page id ' + id);
    if (!HERO_LAYOUTS.includes(page.hero)) fail('hero ' + id);
    if (!LEDGER_VARIANTS.includes(page.ledger)) fail('ledger ' + id);
  }
  for (const id of pageIds) if (!plan.pages?.[id]) fail('missing page ' + id);
  const { plan_sha256, ...body } = plan;
  if (plan_sha256 !== createHash('sha256').update(JSON.stringify(body)).digest('hex')) fail('plan_sha256');
  return plan;
}

/** The planner's inputs, taken from an edition pack's own files (or the pilot's equivalents). */
export function layoutInputsFromPack({ pages, evidence, mediaReport, site, visualPlan }) {
  return {
    pages: pages.map(({ page_id, page_type, evidence_refs }) => ({ page_id, page_type, evidence_refs })),
    evidence: evidence.map(({ evidence_id, value }) => ({ evidence_id, value })),
    media: (mediaReport?.images ?? []).map(({ page_id, kind, review_decision }) => ({ page_id, kind, ...(review_decision ? { review_decision } : {}) })),
    siteName: site?.name ?? '',
    direction: visualPlan?.direction ?? site?.designDirection ?? 'editorial',
  };
}
