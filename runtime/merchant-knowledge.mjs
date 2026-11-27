// Only the authenticated owner route may call mutation methods. The merchant
// binding comes from server configuration, never from tool arguments or a buyer.
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const KINDS = new Set(['general', 'product', 'policy', 'price', 'availability', 'moq', 'lead_time', 'certification']);
const VOLATILE = new Set(['price', 'availability', 'moq', 'lead_time', 'certification']);
const STATUSES = new Set(['supplier-stated', 'merchant-confirmed', 'independently-verified']);
const encoder = new TextEncoder();

export class MerchantDataError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
export const failMerchantData = (code, status) => { throw new MerchantDataError(code, status); };

export function boundedMerchantText(value, max, code = 'INVALID_MERCHANT_TEXT') {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) failMerchantData(code);
  return value.trim();
}

export function publicMerchantUrl(value, { originOnly = false } = {}) {
  if (typeof value !== 'string' || value.length > 2_000 || /[\u0000-\u0020\u007f\\]/.test(value)) failMerchantData('INVALID_MERCHANT_URL');
  let url;
  try { url = new URL(value); } catch { failMerchantData('INVALID_MERCHANT_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.') ||
      /^(?:\d+\.){3}\d+$/.test(url.hostname) || url.hostname.startsWith('[') ||
      /(?:^|\.)(?:localhost|local|internal|invalid)$/.test(url.hostname) ||
      (originOnly && (url.pathname !== '/' || url.search || url.hash))) failMerchantData('INVALID_MERCHANT_URL');
  return originOnly ? url.origin : url.href;
}

export function merchantTimestamp(value, code = 'INVALID_MERCHANT_TIMESTAMP') {
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) failMerchantData(code);
  return new Date(value).toISOString();
}

export function merchantNow(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) failMerchantData('INVALID_MERCHANT_CLOCK');
  return date.toISOString();
}

export function canonicalMerchantJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalMerchantJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalMerchantJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export async function merchantSha256(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function validateMerchantBinding(input) {
  if (!input || typeof input !== 'object' || !ID.test(input.merchantId ?? '') || !SLUG.test(input.siteSlug ?? '')) failMerchantData('INVALID_MERCHANT_BINDING');
  const merchant = {
    merchantId: input.merchantId,
    siteSlug: input.siteSlug,
    name: boundedMerchantText(input.name, 120),
    origin: publicMerchantUrl(input.origin, { originOnly: true }),
    privacyUrl: publicMerchantUrl(input.privacyUrl),
    authorizationRef: boundedMerchantText(input.authorizationRef, 200),
  };
  if (input.knowledgeRevision !== undefined && input.knowledgeRevision !== null) {
    if (!HASH.test(input.knowledgeRevision)) failMerchantData('INVALID_KNOWLEDGE_REVISION');
    merchant.knowledgeRevision = input.knowledgeRevision;
  }
  return Object.freeze(merchant);
}

export async function merchantBindingDigest(input) {
  const { knowledgeRevision: _pin, ...merchant } = validateMerchantBinding(input);
  return merchantSha256(canonicalMerchantJson(merchant));
}

function actor(value) { return boundedMerchantText(value, 160, 'OWNER_ACTOR_REQUIRED'); }
const terms = value => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);

function normalizeFact(record, merchant, now) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) failMerchantData('INVALID_MERCHANT_FACT');
  // A mixed merchant upload is an error, not an implicit transfer of rights.
  if (record.merchant_id !== merchant.merchantId) failMerchantData('KNOWLEDGE_MERCHANT_MISMATCH', 403);
  if (record.publication_permission !== 'approved' || record.audience !== 'public') return null;
  if (!ID.test(record.evidence_id ?? '') || !KINDS.has(record.kind ?? 'general') || !STATUSES.has(record.status)) failMerchantData('INVALID_MERCHANT_FACT');
  const capturedAt = merchantTimestamp(record.captured_at);
  const validUntil = record.valid_until == null ? null : merchantTimestamp(record.valid_until);
  if (Date.parse(capturedAt) > Date.parse(now) || (validUntil && Date.parse(validUntil) <= Date.parse(capturedAt))) failMerchantData('INVALID_FACT_VALIDITY');
  const kind = record.kind ?? 'general';
  if (VOLATILE.has(kind) && !validUntil) failMerchantData('COMMERCIAL_FACT_EXPIRY_REQUIRED');
  // This explicit projection is the only body written to the public version.
  // Internal notes, transcripts, model prompts, and source quotes are not copied.
  return {
    evidence_id: record.evidence_id,
    merchant_id: merchant.merchantId,
    kind,
    claim: boundedMerchantText(record.claim, 400),
    value: boundedMerchantText(record.value, 3_000),
    source_url: publicMerchantUrl(record.source_url),
    captured_at: capturedAt,
    valid_until: validUntil,
    status: record.status,
    audience: 'public',
    publication_permission: 'approved',
  };
}

async function makeBundle(input, merchant, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['facts', 'source_revision'].includes(key)) ||
      !Array.isArray(input.facts) || input.facts.length < 1 || input.facts.length > 1_000) failMerchantData('INVALID_KNOWLEDGE_BUNDLE');
  const facts = input.facts.map(record => normalizeFact(record, merchant, now)).filter(Boolean).sort((a, b) => a.evidence_id < b.evidence_id ? -1 : a.evidence_id > b.evidence_id ? 1 : 0);
  if (!facts.length) failMerchantData('NO_APPROVED_PUBLIC_FACTS');
  if (new Set(facts.map(fact => fact.evidence_id)).size !== facts.length) failMerchantData('DUPLICATE_MERCHANT_FACT');
  return {
    schema_version: 'merchant-knowledge-v1',
    merchant_id: merchant.merchantId,
    site_slug: merchant.siteSlug,
    merchant_name: merchant.name,
    merchant_origin: merchant.origin,
    binding_sha256: await merchantBindingDigest(merchant),
    source_revision: input.source_revision == null ? null : boundedMerchantText(input.source_revision, 128),
    facts,
  };
}

function publicProjection(bundle, revision, now) {
  return {
    schema_version: bundle.schema_version,
    merchant_id: bundle.merchant_id,
    site_slug: bundle.site_slug,
    merchant_name: bundle.merchant_name,
    merchant_origin: bundle.merchant_origin,
    revision,
    effective_at: now,
    facts: bundle.facts.filter(fact => Date.parse(fact.captured_at) <= Date.parse(now) &&
      (!fact.valid_until || Date.parse(fact.valid_until) > Date.parse(now))),
    inference_performed: false,
  };
}

/** D1-backed immutable snapshots. No in-memory or other-merchant fallback. */
export function createMerchantKnowledgeRepository(db, inputMerchant) {
  const merchant = validateMerchantBinding(inputMerchant);
  if (!db || typeof db.prepare !== 'function') failMerchantData('KNOWLEDGE_STORE_UNAVAILABLE', 503);
  const binding = [merchant.siteSlug, merchant.merchantId];

  async function readStored(revision) {
    if (!HASH.test(revision ?? '')) failMerchantData('INVALID_KNOWLEDGE_REVISION');
    const row = await db.prepare('SELECT revision, bundle_json FROM merchant_knowledge_versions WHERE site_slug = ? AND merchant_id = ? AND revision = ?').bind(...binding, revision).first();
    if (!row) return null;
    if (row.revision !== revision || await merchantSha256(row.bundle_json) !== revision) failMerchantData('KNOWLEDGE_INTEGRITY_ERROR', 503);
    let bundle;
    try { bundle = JSON.parse(row.bundle_json); } catch { failMerchantData('KNOWLEDGE_INTEGRITY_ERROR', 503); }
    if (bundle.schema_version !== 'merchant-knowledge-v1' || bundle.merchant_id !== merchant.merchantId || bundle.site_slug !== merchant.siteSlug ||
        bundle.merchant_origin !== merchant.origin || bundle.binding_sha256 !== await merchantBindingDigest(merchant) || !Array.isArray(bundle.facts)) failMerchantData('KNOWLEDGE_BINDING_CHANGED', 409);
    return bundle;
  }

  async function getActive({ now = new Date() } = {}) {
    const head = await db.prepare('SELECT revision FROM merchant_knowledge_heads WHERE site_slug = ? AND merchant_id = ?').bind(...binding).first();
    if (!head) return null;
    if (merchant.knowledgeRevision && head.revision !== merchant.knowledgeRevision) failMerchantData('KNOWLEDGE_REVISION_PINNED', 409);
    const bundle = await readStored(head.revision);
    if (!bundle) failMerchantData('KNOWLEDGE_INTEGRITY_ERROR', 503);
    return publicProjection(bundle, head.revision, merchantNow(now));
  }

  return {
    async saveVersion(input, { actorId, now = new Date() } = {}) {
      const approvedBy = actor(actorId), at = merchantNow(now);
      const bundle = await makeBundle(input, merchant, at);
      const body = canonicalMerchantJson(bundle), revision = await merchantSha256(body);
      if (encoder.encode(body).length > 512_000) failMerchantData('KNOWLEDGE_BUNDLE_TOO_LARGE', 413);
      await db.prepare(`INSERT INTO merchant_knowledge_versions (site_slug, merchant_id, revision, bundle_json, approved_by, approved_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (site_slug, merchant_id, revision) DO NOTHING`).bind(...binding, revision, body, approvedBy, at).run();
      const persisted = await readStored(revision);
      if (!persisted || canonicalMerchantJson(persisted) !== body) failMerchantData('KNOWLEDGE_INTEGRITY_ERROR', 503);
      return { revision, fact_count: bundle.facts.length, excluded_count: input.facts.length - bundle.facts.length, activated: false };
    },
    async activateVersion(revision, { expectedRevision, actorId, now = new Date() } = {}) {
      const activatedBy = actor(actorId), at = merchantNow(now);
      if (expectedRevision !== null && !HASH.test(expectedRevision ?? '')) failMerchantData('EXPECTED_KNOWLEDGE_REVISION_REQUIRED');
      const bundle = await readStored(revision);
      if (!bundle) failMerchantData('KNOWLEDGE_VERSION_NOT_FOUND', 404);
      if (merchant.knowledgeRevision && merchant.knowledgeRevision !== revision) failMerchantData('KNOWLEDGE_REVISION_PINNED', 409);
      if (!publicProjection(bundle, revision, at).facts.length) failMerchantData('NO_CURRENT_PUBLIC_FACTS', 409);
      const result = expectedRevision === null
        ? await db.prepare(`INSERT INTO merchant_knowledge_heads (site_slug, merchant_id, revision, generation, activated_by, activated_at)
            VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT (site_slug, merchant_id) DO NOTHING RETURNING revision, generation`).bind(...binding, revision, activatedBy, at).first()
        : await db.prepare(`UPDATE merchant_knowledge_heads SET revision = ?, generation = generation + 1, activated_by = ?, activated_at = ?
            WHERE site_slug = ? AND merchant_id = ? AND revision = ? RETURNING revision, generation`).bind(revision, activatedBy, at, ...binding, expectedRevision).first();
      if (!result) failMerchantData('KNOWLEDGE_REVISION_CONFLICT', 409);
      return { revision: result.revision, generation: result.generation, activated: true };
    },
    async getVersion(revision, { now = new Date() } = {}) {
      const bundle = await readStored(revision);
      return bundle ? publicProjection(bundle, revision, merchantNow(now)) : null;
    },
    getActive,
    async search(query, { limit = 5, now = new Date() } = {}) {
      query = boundedMerchantText(query, 500, 'INVALID_KNOWLEDGE_QUERY');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) failMerchantData('INVALID_KNOWLEDGE_LIMIT');
      const bundle = await getActive({ now });
      if (!bundle) return { merchant_id: merchant.merchantId, site_slug: merchant.siteSlug, revision: null, effective_at: merchantNow(now), results: [], inference_performed: false };
      const queryTerms = [...new Set(terms(query))].slice(0, 30);
      const results = bundle.facts.map(fact => {
        const words = terms(fact.claim + ' ' + fact.value);
        const score = queryTerms.reduce((sum, term) => sum + (words.includes(term) || (term.length > 1 && words.some(word => word.includes(term))) ? 1 : 0), 0);
        return { fact, score };
      }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || (a.fact.evidence_id < b.fact.evidence_id ? -1 : 1)).slice(0, limit).map(item => item.fact);
      return { merchant_id: merchant.merchantId, site_slug: merchant.siteSlug, revision: bundle.revision, effective_at: bundle.effective_at, results, inference_performed: false };
    },
  };
}
