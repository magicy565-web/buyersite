import { createHash } from 'node:crypto';

const pathKey = (value) => typeof value === 'string' && /^\/(?!\/)[a-z0-9/_-]*$/i.test(value)
  ? value.replace(/\/+$/, '') || '/' : null;
const publicUrl = (value) => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
};
const timestamp = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;

/**
 * Only explicitly publishable, sourced facts enter the public edition data.
 * @param {{ siteSlug: string, name: string, origin: string, briefs: Array<any>, evidence: Array<any>, images?: Array<{page_path: string, kind: string, caption: string, credit: string, sha256: string}>, privatePreview?: boolean }} input
 */
export function buildPublicKnowledge({ siteSlug, name, origin, briefs, evidence, images = [], privatePreview = false }) {
  const base = publicUrl(origin);
  if (!base || !Array.isArray(briefs) || !Array.isArray(evidence)) throw new Error('INVALID_PUBLIC_KNOWLEDGE_INPUT');
  const records = evidence.filter((record) => record.publication_permission === 'approved' && publicUrl(record.source_url))
    .map((record) => ({
      evidence_id: record.evidence_id, claim: record.claim, value: record.value,
      source_url: publicUrl(record.source_url), status: record.status,
      captured_at: timestamp(record.captured_at), valid_until: timestamp(record.valid_until),
      verification: record.status === 'independently-verified' ? 'independently-verified' : 'not-independently-verified',
      record_url: new URL('/sources/#' + encodeURIComponent(record.evidence_id), base).href,
    }));
  if (new Set(records.map((record) => record.evidence_id)).size !== records.length) throw new Error('DUPLICATE_PUBLIC_EVIDENCE');
  const approved = new Set(records.map((record) => record.evidence_id));
  const publicBriefs = briefs.filter((brief) => pathKey(brief.page_path) && Array.isArray(brief.evidence_ids)
    && brief.evidence_ids.every((id) => approved.has(id))).map((brief) => ({
      page_path: brief.page_path, url: new URL(brief.page_path, base).href,
      title: brief.title, product_name: brief.product_name,
      product_id: brief.product_id ?? null, supplier_id: brief.supplier_id ?? null,
      source_url: publicUrl(brief.source_url), summary: brief.summary,
      evidence_ids: [...brief.evidence_ids],
      unconfirmed: brief.unconfirmed.map(({ id, label, detail }) => ({ id, label, detail, status: 'unconfirmed' })),
      questions: brief.questions.map(({ id, label, prompt }) => ({ id, label, prompt })),
      enquiry_url: new URL('/enquiry?from=' + encodeURIComponent(brief.page_path), base).href,
    }));
  if (new Set(publicBriefs.map((brief) => pathKey(brief.page_path))).size !== publicBriefs.length) throw new Error('DUPLICATE_PUBLIC_BRIEF');
  const referenced = new Set(publicBriefs.flatMap((brief) => brief.evidence_ids));
  const payload = {
    schema_version: 'buyer-knowledge-v1',
    edition_id: siteSlug,
    publication: { name, url: base, visibility: privatePreview ? 'private-preview' : 'public' },
    scope: 'Editorial sourcing notes. Supplier statements are not independent verification. Unknown commercial conditions are not offers.',
    briefs: publicBriefs,
    evidence: records.filter((record) => referenced.has(record.evidence_id)),
    images: images.map(({ page_path, kind, caption, credit, sha256 }) => ({ page_path, kind, caption, credit, sha256 })),
  };
  return { ...payload, revision: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}

/** Article-linked subjects, without invented offers, ratings, certifications or real-product images. */
export function structuredSubjects(knowledge, pagePath) {
  const brief = knowledge.briefs.find((item) => pathKey(item.page_path) === pathKey(pagePath));
  if (!brief) return [];
  const facts = knowledge.evidence.filter((record) => brief.evidence_ids.includes(record.evidence_id));
  const subject = brief.product_id && brief.product_name ? {
    '@type': 'Product', '@id': brief.url + '#subject', name: brief.product_name, url: brief.url,
    description: brief.summary,
    additionalProperty: facts.map((record) => ({
      '@type': 'PropertyValue', propertyID: record.record_url, name: record.claim, value: record.value,
      description: `${record.status}. Source captured ${record.captured_at ?? 'date not recorded'}; confirm current applicability.`,
      url: record.source_url,
    })),
  } : {
    '@type': 'CreativeWork', '@id': brief.url + '#sourcing-brief', name: brief.title,
    url: brief.url, description: brief.summary,
  };
  return [subject, {
    '@type': 'Dataset', '@id': new URL('/buyer-data.json#edition', knowledge.publication.url).href,
    name: knowledge.publication.name + ' — source-backed buying notes', description: knowledge.scope,
    url: new URL('/sources/', knowledge.publication.url).href,
    version: knowledge.revision,
    about: { '@id': subject['@id'] },
    citation: [...new Set(facts.map((record) => record.source_url))],
    distribution: { '@type': 'DataDownload', encodingFormat: 'application/json', contentUrl: new URL('/buyer-data.json', knowledge.publication.url).href },
  }];
}
