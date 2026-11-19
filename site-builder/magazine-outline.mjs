import { createHash } from 'node:crypto';

// A deterministic editorial outline from the EXISTING source-backed site compiler.
// This is a proposal for an agent and visual director, NOT a published IssueSpec.
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SHA = /^[0-9a-f]{64}$/;
const fail = (message) => { throw new TypeError('MAGAZINE_OUTLINE: ' + message); };
const uniq = (items) => [...new Set(items)];

export function planMagazineOutline(compiled) {
  if (!compiled || !SHA.test(compiled.fingerprint || '') ||
      !compiled.site || !Array.isArray(compiled.articles) ||
      !Array.isArray(compiled.evidence)) fail('valid compiled company edition required');

  const articleById = new Map();
  for (const article of compiled.articles) {
    if (!article || !SAFE_ID.test(article.slug || '') || articleById.has(article.slug) ||
        !Array.isArray(article.refs) || !article.refs.every((ref) => typeof ref === 'string')) {
      fail('unique source-backed articles required');
    }
    articleById.set(article.slug, article);
  }
  const evidenceById = new Map();
  for (const item of compiled.evidence) {
    if (!item || typeof item.evidence_id !== 'string' ||
        !SAFE_ID.test(item.evidence_id) || evidenceById.has(item.evidence_id)) {
      fail('unique evidence IDs required');
    }
    evidenceById.set(item.evidence_id, item);
  }
  for (const article of compiled.articles) {
    for (const ref of article.refs) {
      if (!evidenceById.has(ref)) fail('article references unknown evidence: ' + ref);
    }
  }

  const supplier = compiled.articles.find((article) => article.pageType === 'supplier-profile');
  const guide = compiled.articles.find((article) => article.pageType === 'buyer-guide');
  const products = compiled.articles.filter((article) => article.pageType === 'product-editorial');
  if (!supplier || !guide || products.length > 12) fail('supplier, guide and bounded products required');
  if (compiled.articles.filter((article) => article.pageType === 'supplier-profile').length !== 1 ||
      compiled.articles.filter((article) => article.pageType === 'buyer-guide').length !== 1) {
    fail('exactly one supplier profile and buyer guide required');
  }

  const chapters = [];
  const add = (id, layout, purpose, articleIds) => {
    const evidenceRefs = uniq(articleIds.flatMap((key) => articleById.get(key)?.refs || []));
    chapters.push({
      id, layout, purpose,
      article_ids: articleIds,
      evidence_refs: evidenceRefs,
      // Any photo still needs rights verification via the current media-report/registry.
      media_binding: 'unresolved',
      review_status: 'required',
    });
  };
  add('cover', 'cover', 'Introduce the subject without asserting unknown product properties', [supplier.slug]);
  add('contents', 'contents', 'Show the reading path and navigable chapters', []);
  add('company-story', 'story', 'Frame the approved supplier statements as attributed claims', [supplier.slug]);
  if (products.length) {
    add('product-portfolio', 'gallery', 'Show only selected product records with licensed or disclosed illustrative media', products.slice(0, 4).map((x) => x.slug));
  }
  add('source-notebook', 'notes', 'Show what is known, supplier-stated and still unverified', [supplier.slug, ...products.map((x) => x.slug)]);
  add('buyer-questions', 'notes', 'Turn unknown commercial conditions into buyer questions', [guide.slug]);
  add('sourcing', 'sourcing', 'Prepare, do not send, a contextual buyer enquiry', [guide.slug]);

  const output = {
    schema_version: '1.0.0',
    kind: 'source-bound-magazine-outline',
    publication_status: 'private-review',
    source_fingerprint: compiled.fingerprint,
    site_slug: compiled.site.slug,
    brand: compiled.site.name,
    design_direction: compiled.visualPlan?.direction || 'editorial',
    chapters,
    // No prose, photography, price, MOQ or delivery promises are synthesized here.
    media_policy: 'bind-after-rights-check',
    approval_required: ['editorial-content', 'media-rights', 'visual-review', 'enquiry-backend', 'release'],
  };
  return { ...output, outline_sha256: createHash('sha256').update(JSON.stringify(output)).digest('hex') };
}
