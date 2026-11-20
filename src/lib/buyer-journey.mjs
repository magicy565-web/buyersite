// Session-only navigation context. No visitor identifiers, contact data or chat history.
export const BRIEF_HANDOFF_KEY = 'buyersite:brief:v1';
const keyFor = (siteSlug) => 'buyersite:journey:v1:' + siteSlug;
const receiptKeyFor = (siteSlug) => 'buyersite:receipt:v1:' + siteSlug;

export function privacyOptOut(navigatorLike = globalThis.navigator) {
  return navigatorLike?.globalPrivacyControl === true || ['1', 'yes'].includes(navigatorLike?.doNotTrack);
}

export function normalizeKnownPath(value, allowedPaths) {
  if (!Array.isArray(allowedPaths) || typeof value !== 'string' || value.length > 240 || !value.startsWith('/') || value.startsWith('//') || /[?#\\\u0000-\u0020]/.test(value)) return null;
  const normalized = value.replace(/\/+$/, '') || '/';
  return allowedPaths.some((path) => typeof path === 'string' && (path.replace(/\/+$/, '') || '/') === normalized) ? normalized : null;
}

// Campaign labels, never free-form URLs, addresses, click IDs or search terms.
export function sanitizeCampaign(input, { strict = false } = {}) {
  const fail = () => { if (strict) throw new Error('Use bounded source, medium and campaign labels.'); };
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) { fail(); return {}; }
  if (Object.keys(input).some((key) => !['source', 'medium', 'campaign'].includes(key))) { fail(); return {}; }
  const output = {};
  for (const name of ['source', 'medium', 'campaign']) {
    const value = input[name];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') { fail(); continue; }
    const label = value.trim();
    const max = name === 'campaign' ? 64 : 32;
    const mausbotCampaignId = name === 'campaign' && /^cmp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(label);
    if (!label || label.length > max || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(label) || (!mausbotCampaignId && (/\d{6,}/.test(label) || /^[a-f0-9]{8}-[a-f0-9-]{20,}$/i.test(label)))) { fail(); continue; }
    output[name] = label;
  }
  return output;
}

export function clearJourney(storage, siteSlug) {
  try { storage?.removeItem(keyFor(siteSlug)); } catch {}
}

export function readJourney(storage, siteSlug, allowedPaths, articlePaths, optedOut = false) {
  if (optedOut) { clearJourney(storage, siteSlug); return null; }
  try {
    const raw = storage?.getItem(keyFor(siteSlug));
    if (!raw || raw.length > 2_000) return null;
    const data = JSON.parse(raw);
    if (!data || data.version !== 1 || data.site_slug !== siteSlug) return null;
    const landing = normalizeKnownPath(data.landing_path, allowedPaths);
    const article = data.article_path == null ? null : normalizeKnownPath(data.article_path, articlePaths);
    if (!landing || (data.article_path != null && !article)) return null;
    return { version: 1, site_slug: siteSlug, landing_path: landing, article_path: article, campaign: sanitizeCampaign(data.campaign, { strict: true }) };
  } catch { return null; }
}

export function captureJourney(storage, { siteSlug, allowedPaths, articlePaths, path, search = '', optedOut = false }) {
  if (optedOut) { clearJourney(storage, siteSlug); return null; }
  const current = normalizeKnownPath(path, allowedPaths);
  if (!current) return null;
  const existing = readJourney(storage, siteSlug, allowedPaths, articlePaths);
  const params = new URLSearchParams(search);
  const campaign = existing?.campaign ?? sanitizeCampaign(Object.fromEntries(['source', 'medium', 'campaign'].map((name) => [name, params.get('utm_' + name) ?? ''])));
  const journey = {
    version: 1, site_slug: siteSlug, landing_path: existing?.landing_path ?? current,
    article_path: normalizeKnownPath(current, articlePaths) ?? existing?.article_path ?? null, campaign,
  };
  try { if (!storage) return null; storage.setItem(keyFor(siteSlug), JSON.stringify(journey)); return journey; }
  catch { return null; }
}

export function findPublishedContext(path, contexts) {
  const known = normalizeKnownPath(path, contexts.map((context) => context.page_path));
  return known ? contexts.find((context) => (context.page_path.replace(/\/+$/, '') || '/') === known) ?? null : null;
}

export function saveBriefHandoff(storage, draft, contexts) {
  if (!draft || draft.version !== 1 || typeof draft.site_slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(draft.site_slug)) return false;
  const context = findPublishedContext(draft.page_path, contexts);
  if (!context || !Array.isArray(draft.question_ids) || draft.question_ids.length > 20) return false;
  const knownIds = new Set(context.questions.map((question) => question.id));
  if (draft.question_ids.some((id) => typeof id !== 'string' || !knownIds.has(id))) return false;
  const requirements = {};
  for (const [name, max] of [['quantity', 200], ['application', 2_000], ['delivery', 300]]) {
    const value = draft.requirements?.[name];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return false;
    requirements[name] = value.trim();
  }
  const payload = { version: 1, site_slug: draft.site_slug, page_path: context.page_path,
    question_ids: [...new Set(draft.question_ids)], requirements };
  try { storage.setItem(BRIEF_HANDOFF_KEY, JSON.stringify(payload)); return true; } catch { return false; }
}

export function readBriefHandoff(storage, siteSlug, contexts) {
  try {
    const raw = storage?.getItem(BRIEF_HANDOFF_KEY);
    if (!raw) return null;
    storage.removeItem(BRIEF_HANDOFF_KEY);
    if (raw.length > 5_000) return null;
    const data = JSON.parse(raw);
    if (data?.site_slug !== siteSlug) return null;
    // Reuse the write validator without persisting the draft again.
    let checked;
    if (!saveBriefHandoff({ setItem(_key, value) { checked = JSON.parse(value); } }, data, contexts)) return null;
    return checked;
  } catch { return null; }
}

export function buyerNavigationPaths(contexts) {
  return [...new Set(['/', '/enquiry', '/search', '/colophon', '/privacy', '/sources',
    ...contexts.map((context) => context.page_path),
    ...contexts.map((context) => '/' + context.page_path.split('/')[1])])];
}

function checkedReceipt(value, siteSlug) {
  if (!value || value.site_slug !== siteSlug || typeof value.receipt_id !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.receipt_id) ||
      typeof value.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.created_at) ||
      !Number.isFinite(Date.parse(value.created_at)) || !['new', 'qualified', 'archived'].includes(value.status) ||
      value.destination !== 'buyersite-editorial-inbox' || value.supplier_sent !== false) return null;
  return { site_slug: siteSlug, receipt_id: value.receipt_id, created_at: value.created_at,
    status: value.status, destination: value.destination, supplier_sent: false };
}

export function saveReceipt(storage, siteSlug, receipt) {
  const value = checkedReceipt({ ...receipt, site_slug: siteSlug }, siteSlug);
  if (!value) return false;
  try { storage.setItem(receiptKeyFor(siteSlug), JSON.stringify(value)); return true; } catch { return false; }
}

export function readReceipt(storage, siteSlug) {
  try {
    const raw = storage?.getItem(receiptKeyFor(siteSlug));
    if (!raw) return null;
    if (raw.length > 1_000) { clearReceipt(storage, siteSlug); return null; }
    const value = checkedReceipt(JSON.parse(raw), siteSlug);
    if (!value) clearReceipt(storage, siteSlug);
    return value;
  } catch { clearReceipt(storage, siteSlug); return null; }
}

export function clearReceipt(storage, siteSlug) {
  try { storage?.removeItem(receiptKeyFor(siteSlug)); } catch {}
}
