import { createHash } from 'node:crypto';

// Authorization comes from a frozen, server-owned enterprise snapshot. This
// module does not grant rights: it verifies a documented publication grant.
const HEX = /^[a-f0-9]{64}$/;
const ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const MAX_ASSETS = 48;
export const MEDIA_KINDS = Object.freeze(['licensed-photo', 'ai-generated', 'abstract-fallback']);

export class MediaPolicyError extends Error {
  constructor(code, message) { super(message); this.name = 'MediaPolicyError'; this.code = code; }
}
const reject = (code, message) => { throw new MediaPolicyError(code, message); };
const safeText = (s, maximum) => typeof s === 'string' && s.length > 0 && s.length <= maximum && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s);
const isDate = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);

export function normalizeMediaAssets(assets = [], asOf = new Date().toISOString()) {
  if (!isDate(asOf)) reject('MEDIA_SNAPSHOT_DATE_INVALID', 'Snapshot timestamp required');
  if (!Array.isArray(assets) || assets.length > MAX_ASSETS) reject('MEDIA_ASSET_LIST_INVALID', 'Expected a bounded list of private asset references');
  const ids = new Set();
  return assets.map((asset) => {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset) ||
        !ID.test(asset.asset_id || '') || ids.has(asset.asset_id) ||
        !ID.test(asset.page_id || '') ||
        !HEX.test(asset.sha256 || '') ||
        !safeText(asset.alt, 300) || !safeText(asset.credit, 180)) {
      reject('MEDIA_ASSET_INVALID', 'Asset identifiers, SHA-256, alt text and credit are required');
    }
    ids.add(asset.asset_id);
    const rights = asset.rights;
    const approved = rights && rights.status === 'approved-public' &&
      rights.scope === 'buyer-magazine-site' &&
      HEX.test(rights.grant_sha256 || '') &&
      safeText(rights.granted_by, 120) &&
      isDate(rights.approved_at) &&
      rights.allow_resize === true &&
      rights.allow_crop === true &&
      (!rights.expires_at || (isDate(rights.expires_at) && Date.parse(rights.expires_at) > Date.parse(asOf)));
    return {
      asset_id: asset.asset_id,
      page_id: asset.page_id,
      sha256: asset.sha256,
      alt: asset.alt.trim(),
      credit: asset.credit.trim(),
      approved: Boolean(approved),
      grant_sha256: approved ? rights.grant_sha256 : null,
      // Rights metadata is retained; URLs in untrusted media descriptors
      // are deliberately not downloaded by the builder.
      rights_status: rights?.status || 'unconfirmed',
    };
  });
}

export function planMedia(articles, assets = [], asOf = new Date().toISOString()) {
  if (!Array.isArray(articles)) reject('MEDIA_ARTICLES_INVALID', 'Articles are required');
  const normalized = normalizeMediaAssets(assets, asOf);
  const pages = new Set(articles.map((article) => article.slug));
  if (pages.size !== articles.length || articles.some((a) => !ID.test(a.slug || ''))) reject('MEDIA_ARTICLES_INVALID', 'Article paths must be unique and safe');
  if (normalized.some((asset) => !pages.has(asset.page_id))) reject('MEDIA_PAGE_UNKNOWN', 'Image must target an existing page');
  const selections = articles.map((article) => {
    const candidates = normalized.filter((asset) => asset.page_id === article.slug);
    const licensed = candidates.find((asset) => asset.approved);
    return licensed ? {
      page_id: article.slug, media_kind: 'licensed-photo', asset_id: licensed.asset_id,
      source_sha256: licensed.sha256, grant_sha256: licensed.grant_sha256,
      alt: licensed.alt, credit: licensed.credit,
      fallback_reason: null,
    } : {
      page_id: article.slug, media_kind: 'generation-requested', asset_id: null,
      source_sha256: null, grant_sha256: null,
      alt: 'Conceptual editorial illustration for ' + article.title,
      credit: 'AI-generated concept illustration; not a supplier product photograph',
      fallback_reason: candidates.length ? 'NO_PUBLICATION_GRANT' : 'NO_APPROVED_ASSET',
    };
  });
  return {
    schema_version: '1.0.0',
    approved_count: selections.filter((s) => s.media_kind === 'licensed-photo').length,
    missing_count: selections.filter((s) => s.media_kind !== 'licensed-photo').length,
    selections,
    // Immutable source planning ID, not an approval token.
    plan_sha256: createHash('sha256').update(JSON.stringify(selections)).digest('hex'),
  };
}
