import { buildSourceGuideReply } from './source-guide.mjs';
import { findPublishedContext, normalizeKnownPath, sanitizeCampaign } from '../src/lib/buyer-journey.mjs';
import { enqueueMarketingEvent, dispatchMarketingOutbox } from './marketing-outbox.mjs';

/**
 * Same-origin conversion adapter for the static magazine.
 * D1 holds buyer intent; OpenMausBot remains the optional sourcing service.
 * No endpoint sends a message to a supplier or fabricates a model response.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY = 16_384;
const MAX_UPSTREAM = 96_000;
const textEncoder = new TextEncoder();
const consentVersion = 'buyer-enquiry-v1';

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(value, status = 200, extra = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      ...extra,
    },
  });
}

async function sha(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', textEncoder.encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function boundedJson(message, max = MAX_BODY) {
  if (!message.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'JSON_REQUIRED', 'Send this request as JSON.');
  }
  const declared = Number(message.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    throw new HttpError(413, 'BODY_TOO_LARGE', 'This request is too large.');
  }
  const reader = message.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_JSON', 'The request body is missing.');
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new HttpError(413, 'BODY_TOO_LARGE', 'This request is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error();
    return value;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'The request must contain a JSON object.');
  }
}

function sameOrigin(request) {
  const expected = new URL(request.url).origin;
  if (request.headers.get('origin') !== expected || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'ORIGIN_REJECTED', 'Submit the enquiry from this website.');
  }
}

function field(value, name, max, required = true) {
  if (!required && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || value.trim().length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new HttpError(400, 'INVALID_FIELD', `Check the ${name} field.`);
  }
  const normalized = value.trim();
  if (required && !normalized) throw new HttpError(400, 'INVALID_FIELD', `Enter ${name}.`);
  return normalized;
}

function pagePath(value, config) {
  const path = field(value ?? '/enquiry', 'source page', 240);
  if (!path.startsWith('/') || path.startsWith('//') || /[?#\\]/.test(path)) {
    throw new HttpError(400, 'INVALID_PAGE', 'The source page is not valid.');
  }
  const normalized = path.replace(/\/+$/, '') || '/';
  const allowed = new Set((config.allowedPaths ?? ['/', '/enquiry', '/search']).map((p) => p.replace(/\/+$/, '') || '/'));
  if (!allowed.has(normalized)) throw new HttpError(400, 'INVALID_PAGE', 'The source page is not part of this edition.');
  return normalized;
}

function publishedBrief(path, config) {
  const brief = findPublishedContext(path, Array.isArray(config.buyerBriefs) ? config.buyerBriefs : []);
  if (!brief) return null;
  const safeText = (value, max, nullable = false) => {
    if (nullable && value == null) return null;
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error('Invalid published context');
    return value;
  };
  if (!normalizeKnownPath(brief.page_path, config.allowedPaths) || !Array.isArray(brief.evidence_ids) || brief.evidence_ids.length > 100 ||
      !Array.isArray(brief.questions) || brief.questions.length > 20 || !Array.isArray(brief.unconfirmed) || brief.unconfirmed.length > 20) throw new Error('Invalid published context');
  const source = safeText(brief.source_url, 2_000, true);
  if (source) { const url = new URL(source); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid published citation'); }
  return {
    page_path: normalizeKnownPath(brief.page_path, config.allowedPaths), title: safeText(brief.title, 400),
    product_name: safeText(brief.product_name, 300), product_id: safeText(brief.product_id, 200, true),
    supplier_id: safeText(brief.supplier_id, 200, true), source_url: source,
    knowledge_revision: safeText(config.knowledgeRevision ?? null, 128, true),
    evidence_ids: brief.evidence_ids.map((id) => safeText(id, 120)),
    unconfirmed: brief.unconfirmed.map((item) => ({ id: safeText(item.id, 120), label: safeText(item.label, 200), detail: safeText(item.detail, 2_000) })),
    questions: brief.questions.map((item) => ({ id: safeText(item.id, 120), label: safeText(item.label, 200), prompt: safeText(item.prompt, 2_000) })),
  };
}

function validateEnquiry(body, config, request) {
  if (body.site_slug !== undefined && body.site_slug !== config.siteSlug) {
    throw new HttpError(400, 'INVALID_SITE', 'This enquiry belongs to another edition.');
  }
  if (body.website) throw new HttpError(400, 'INVALID_SUBMISSION', 'The enquiry could not be accepted.');
  if (body.consent !== true || body.consent_version !== consentVersion) {
    throw new HttpError(400, 'CONSENT_REQUIRED', 'Agree to contact and enquiry storage before sending.');
  }
  const email = field(body.email, 'email address', 254);
  if (!/^[^\s@<>]+@[^\s@<>.]+(?:\.[^\s@<>.]+)+$/.test(email)) {
    throw new HttpError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
  }
  if (['product_id', 'supplier_id', 'source_url', 'evidence_ids', 'context_json', 'product_name', 'context_title'].some((key) => Object.hasOwn(body, key))) {
    throw new HttpError(400, 'INVALID_CONTEXT', 'Choose an article from this edition; product and source identifiers are assigned by the server.');
  }
  if (body.attribution_opt_out !== undefined && typeof body.attribution_opt_out !== 'boolean') throw new HttpError(400, 'INVALID_ATTRIBUTION', 'The attribution preference is not valid.');
  const optedOut = body.attribution_opt_out === true || request.headers.get('DNT') === '1' || request.headers.get('Sec-GPC') === '1';
  let attribution = {};
  if (!optedOut) {
    try { attribution = sanitizeCampaign(body.attribution, { strict: true }); }
    catch { throw new HttpError(400, 'INVALID_ATTRIBUTION', 'Use bounded source, medium and campaign labels without personal details.'); }
  }
  const data = {
    email,
    name: field(body.name, 'name', 100, false),
    company: field(body.company, 'company', 160, false),
    material: field(body.material, 'product or material', 200),
    quantity: field(body.quantity, 'quantity and unit', 200),
    application: field(body.application, 'application and specification', 2_000),
    delivery: field(body.delivery, 'destination and target delivery', 300),
    page_path: pagePath(body.page_path, config),
    attribution,
    consent_version: consentVersion,
  };
  const modern = ['context_page_path', 'question_ids', 'landing_page_path', 'attribution_opt_out'].some((key) => Object.hasOwn(body, key));
  if (modern || optedOut) {
    let context = null;
    if (body.context_page_path !== undefined && body.context_page_path !== null && body.context_page_path !== '') {
      context = publishedBrief(body.context_page_path, config);
      if (!context) throw new HttpError(400, 'INVALID_CONTEXT', 'Choose a published article from this edition.');
    }
    const questionIds = body.question_ids ?? [];
    if (!Array.isArray(questionIds) || questionIds.length > 20 || questionIds.some((id) => typeof id !== 'string') || new Set(questionIds).size !== questionIds.length ||
        questionIds.some((id) => !context?.questions.some((question) => question.id === id))) {
      throw new HttpError(400, 'INVALID_QUESTIONS', 'Choose questions from the linked article.');
    }
    if (context) context.questions = context.questions.filter((question) => questionIds.includes(question.id));
    let landing = null;
    if (!optedOut && body.landing_page_path != null && body.landing_page_path !== '') {
      landing = normalizeKnownPath(body.landing_page_path, config.allowedPaths);
      if (!landing) throw new HttpError(400, 'INVALID_ATTRIBUTION', 'The landing page must belong to this edition.');
    }
    Object.assign(data, { context, landing_page_path: landing,
      attribution_method: optedOut ? 'withheld' : landing ? 'reported-session' : Object.keys(attribution).length ? 'reported-campaign' : null,
      attribution_opt_out: optedOut });
  }
  return data;
}

function dbReady(env) {
  return Boolean(env.DB && typeof env.DB.prepare === 'function');
}

function sourcingBase(env) {
  if (typeof env.BUYERSITE_SOURCING_TOKEN !== 'string' || env.BUYERSITE_SOURCING_TOKEN.length < 16) return null;
  try {
    const url = new URL(env.BUYERSITE_SOURCING_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return url;
  } catch { return null; }
}

async function limitRequest(request, env, config, scope, limit, seconds) {
  const start = Math.floor(Date.now() / (seconds * 1_000)) * seconds;
  // The trusted Cloudflare header is never stored. Its short-lived hash is only an abuse bucket.
  const ip = request.headers.get('CF-Connecting-IP') || 'local-preview';
  const bucket = await sha(`${config.siteSlug}:${scope}:${start}:${ip}`);
  const row = await env.DB.prepare(`INSERT INTO buyer_rate_limits
    (site_slug, scope, bucket, window_start, count, expires_at) VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT (site_slug, scope, bucket, window_start) DO UPDATE SET count = count + 1
    WHERE count < ? RETURNING count`).bind(config.siteSlug, scope, bucket, start, start + seconds * 2, limit).first();
  if (!row) {
    const error = new HttpError(429, 'RATE_LIMITED', 'Please wait before sending another request.');
    error.retryAfter = Math.max(1, start + seconds - Math.floor(Date.now() / 1_000));
    throw error;
  }
  await env.DB.prepare(`DELETE FROM buyer_rate_limits WHERE rowid IN
    (SELECT rowid FROM buyer_rate_limits WHERE expires_at < ? LIMIT 100)`).bind(Math.floor(Date.now() / 1_000)).run();
}

function receipt(row, replay = false) {
  return json({
    receipt_id: row.id,
    created_at: row.created_at,
    status: row.status,
    destination: 'buyersite-editorial-inbox',
    supplier_sent: false,
    replay,
  }, replay ? 200 : 201);
}


async function queueInquiryMarketingEvent(request, env, config, data, enquiry, executionContext) {
  // The outbox contains only campaign attribution and an opaque enquiry receipt id.
  // Contact details, product requirements and buyer free text never leave D1 here.
  const utm = data.attribution ?? {};
  const landingPath = data.landing_page_path ?? data.page_path;
  const queued = await enqueueMarketingEvent(env, config, {
    eventId: 'buyersite:' + config.siteSlug + ':inquiry:' + enquiry.id,
    campaignId: utm.campaign,
    type: 'inquiry_submitted',
    occurredAt: enquiry.created_at,
    landingUrl: new URL(landingPath, request.url).href,
    pagePath: data.page_path,
    utm,
    inquiryId: enquiry.id,
    metadata: { destination: 'buyersite-editorial-inbox', attributionMethod: data.attribution_method ?? null },
  });
  if (queued && executionContext?.waitUntil) executionContext.waitUntil(dispatchMarketingOutbox(env, config));
}

async function saveEnquiry(request, env, config, executionContext) {
  sameOrigin(request);
  if (!config.enquiriesEnabled || !dbReady(env)) {
    throw new HttpError(503, 'ENQUIRIES_UNAVAILABLE', 'The enquiry inbox is unavailable. Download your brief and try again later.');
  }
  const key = request.headers.get('idempotency-key') ?? '';
  if (!UUID.test(key)) throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Refresh the page before trying again.');
  const data = validateEnquiry(await boundedJson(request), config, request);
  const keyHash = await sha(key);
  // Keep the legacy payload shape stable. New retries bind the buyer's selected IDs,
  // not mutable catalog wording; the first saved context snapshot remains immutable.
  const hashData = data.context ? { ...data, context: { page_path: data.context.page_path, question_ids: data.context.questions.map((question) => question.id).sort() } } : data;
  const payloadHash = await sha(JSON.stringify(hashData));
  const existing = await env.DB.prepare(`SELECT id, created_at, status, payload_hash FROM buyer_enquiries
    WHERE site_slug = ? AND idempotency_key_hash = ?`).bind(config.siteSlug, keyHash).first();
  if (existing) {
    if (existing.payload_hash !== payloadHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'The brief changed. Start a new enquiry before sending it.');
    await queueInquiryMarketingEvent(request, env, config, data, existing, executionContext);
    return receipt(existing, true);
  }
  await limitRequest(request, env, config, 'enquiry', 5, 3_600);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const inserted = await env.DB.prepare(`INSERT INTO buyer_enquiries
    (id, site_slug, idempotency_key_hash, payload_hash, created_at, updated_at, status,
      email, name, company, material, quantity, application, delivery, page_path,
      attribution_json, consent_version, consent_at, context_json, originating_page_path, landing_page_path, attribution_method)
    VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (site_slug, idempotency_key_hash) DO NOTHING RETURNING id, created_at, status`)
    .bind(id, config.siteSlug, keyHash, payloadHash, now, now, data.email, data.name, data.company,
      data.material, data.quantity, data.application, data.delivery, data.page_path,
      JSON.stringify(data.attribution), data.consent_version, now, data.context ? JSON.stringify(data.context) : null,
      data.context?.page_path ?? null, data.landing_page_path ?? null,
      data.attribution_method ?? (Object.keys(data.attribution).length ? 'reported-campaign' : null)).first();
  if (inserted) {
    await queueInquiryMarketingEvent(request, env, config, data, inserted, executionContext);
    return receipt(inserted);
  }
  // A concurrent retry may have won the unique-key race after our first read.
  const raced = await env.DB.prepare(`SELECT id, created_at, status, payload_hash FROM buyer_enquiries
    WHERE site_slug = ? AND idempotency_key_hash = ?`).bind(config.siteSlug, keyHash).first();
  if (!raced || raced.payload_hash !== payloadHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'Start a new enquiry for the changed brief.');
  await queueInquiryMarketingEvent(request, env, config, data, raced, executionContext);
  return receipt(raced, true);
}

export async function authorizedOwner(request, env) {
  const expected = env.BUYERSITE_ADMIN_TOKEN;
  const actual = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (typeof expected !== 'string' || expected.length < 32 || actual.length < 32 || actual.length > 512) {
    throw new HttpError(401, 'OWNER_AUTH_REQUIRED', 'Owner authentication is required.');
  }
  const [a, b] = await Promise.all([sha(actual), sha(expected)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  if (difference) throw new HttpError(401, 'OWNER_AUTH_REQUIRED', 'Owner authentication is required.');
  if (!dbReady(env)) throw new HttpError(503, 'INBOX_UNAVAILABLE', 'The enquiry inbox is unavailable.');
}

async function ownerEnquiries(request, env, config, id) {
  await authorizedOwner(request, env);
  if (request.method === 'GET' && !id) {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit') || 20);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, 'INVALID_LIMIT', 'The limit must be between 1 and 50.');
    const cursor = url.searchParams.get('cursor');
    const [before, beforeId] = cursor ? cursor.split('|') : ['9999-12-31T23:59:59.999Z', 'ffffffff-ffff-4fff-bfff-ffffffffffff'];
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(before ?? '') || !UUID.test(beforeId ?? '') || (cursor && cursor.split('|').length !== 2)) {
      throw new HttpError(400, 'INVALID_CURSOR', 'The date cursor is invalid.');
    }
    const rows = await env.DB.prepare(`SELECT id, created_at, updated_at, status, email, name, company,
      material, quantity, application, delivery, page_path, attribution_json, consent_version, consent_at,
      context_json, originating_page_path, landing_page_path, attribution_method
      FROM buyer_enquiries WHERE site_slug = ? AND (created_at < ? OR (created_at = ? AND id < ?))
      ORDER BY created_at DESC, id DESC LIMIT ?`)
      .bind(config.siteSlug, before, before, beforeId, limit + 1).all();
    const items = (rows.results ?? []).slice(0, limit);
    const last = items.at(-1);
    return json({ items, next_cursor: (rows.results ?? []).length > limit && last ? `${last.created_at}|${last.id}` : null });
  }
  if (request.method === 'PATCH' && UUID.test(id ?? '')) {
    const body = await boundedJson(request);
    if (!['new', 'qualified', 'archived'].includes(body.status)) throw new HttpError(400, 'INVALID_STATUS', 'Choose new, qualified or archived.');
    const updated = await env.DB.prepare(`UPDATE buyer_enquiries SET status = ?, updated_at = ?
      WHERE id = ? AND site_slug = ? RETURNING id, status, updated_at`)
      .bind(body.status, new Date().toISOString(), id, config.siteSlug).first();
    if (!updated) throw new HttpError(404, 'ENQUIRY_NOT_FOUND', 'The enquiry was not found.');
    return json(updated);
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'This method is not supported.');
}

async function upstreamJson(url, env, body, extraHeaders, fetchFn) {
  const response = await fetchFn(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${env.BUYERSITE_SOURCING_TOKEN}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new HttpError(502, 'SOURCING_UNAVAILABLE', 'The sourcing service could not answer. Your enquiry has not been sent.');
  try { return await boundedJson(response, MAX_UPSTREAM); }
  catch { throw new HttpError(502, 'INVALID_SOURCING_RESPONSE', 'The sourcing service returned an unsupported response.'); }
}

async function answerQuestion(request, env, config, fetchFn) {
  sameOrigin(request);
  const base = sourcingBase(env);
  if (!config.enquiriesEnabled || !base || !dbReady(env)) throw new HttpError(503, 'SOURCING_NOT_CONFIGURED', 'Live AI sourcing is not connected. Use the source notes or prepare an enquiry.');
  const body = await boundedJson(request);
  const message = field(body.message, 'question', 2_000);
  const path = pagePath(body.page_path, config);
  const locale = field(body.locale || 'en', 'language', 20);
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale)) throw new HttpError(400, 'INVALID_LANGUAGE', 'The language is not valid.');
  await limitRequest(request, env, config, 'assistant', 15, 600);
  const sitePrefix = `${base.pathname.replace(/\/$/, '')}/v1/public-sites/${config.siteSlug}`;
  const endpoint = (suffix) => new URL(sitePrefix + suffix, base.origin);
  let publicSession = request.headers.get('x-buyer-session');
  let upstreamSession;
  if (publicSession) {
    if (!UUID.test(publicSession)) throw new HttpError(401, 'SESSION_EXPIRED', 'Start a new conversation.');
    const record = await env.DB.prepare(`SELECT upstream_session_id FROM buyer_assistant_sessions
      WHERE id = ? AND site_slug = ? AND expires_at > ?`)
      .bind(publicSession, config.siteSlug, new Date().toISOString()).first();
    if (!record) throw new HttpError(401, 'SESSION_EXPIRED', 'This conversation expired. Send the question again to start a new one.');
    upstreamSession = record.upstream_session_id;
  } else {
    const started = await upstreamJson(endpoint('/sessions'), env, {
      page_url: new URL(path, request.url).href,
      locale,
    }, { 'X-Buyersite-Site': config.siteSlug }, fetchFn);
    if (typeof started.session_id !== 'string' || !/^[A-Za-z0-9_-]{8,200}$/.test(started.session_id)) {
      throw new HttpError(502, 'INVALID_SOURCING_RESPONSE', 'The sourcing service could not start a conversation.');
    }
    publicSession = crypto.randomUUID();
    upstreamSession = started.session_id;
    const now = new Date();
    await env.DB.prepare(`INSERT INTO buyer_assistant_sessions (id, site_slug, upstream_session_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)`).bind(publicSession, config.siteSlug, upstreamSession, now.toISOString(), new Date(now.getTime() + 3_600_000).toISOString()).run();
    await env.DB.prepare(`DELETE FROM buyer_assistant_sessions WHERE id IN
      (SELECT id FROM buyer_assistant_sessions WHERE expires_at < ? LIMIT 100)`).bind(now.toISOString()).run();
  }
  const result = await upstreamJson(endpoint('/chat'), env, {
    message,
    page_url: new URL(path, request.url).href,
    product_context: (() => {
      const brief = publishedBrief(path, config);
      if (!brief) return null;
      return { ...brief, knowledge_revision: typeof config.knowledgeRevision === 'string' ? config.knowledgeRevision : null,
        evidence: (config.sourceRecords ?? []).filter((record) => brief.evidence_ids.includes(record.id) && normalizeKnownPath(record.page_path, config.allowedPaths) === brief.page_path)
          .map(({ id, claim, value, source_url, status, captured_at }) => ({ id, claim, value, source_url, status, captured_at })) };
    })(),
  }, { 'X-Visitor-Session': upstreamSession, 'X-Buyersite-Site': config.siteSlug }, fetchFn);
  if (typeof result.answer !== 'string' || !result.answer.trim() || result.answer.length > 24_000) {
    throw new HttpError(502, 'INVALID_SOURCING_RESPONSE', 'The sourcing service returned an unsupported answer.');
  }
  return json({ answer: result.answer, session_id: publicSession, mode: 'connected', supplier_sent: false });
}

async function sourceGuide(request, env, config) {
  sameOrigin(request);
  const body = await boundedJson(request, 2_048);
  if (body.site_slug !== config.siteSlug || Object.keys(body).some((key) => !['query', 'site_slug', 'page_path'].includes(key))) {
    throw new HttpError(400, 'INVALID_SOURCE_QUERY', 'Search within the current edition.');
  }
  const query = field(body.query, 'source search', 200);
  if (!Array.isArray(config.sourceRecords) || !config.sourceRecords.length) {
    throw new HttpError(503, 'SOURCES_UNAVAILABLE', 'Source search is unavailable. Use the edition search or source notes.');
  }
  if (dbReady(env)) await limitRequest(request, env, config, 'source-guide', 30, 600);
  return json(buildSourceGuideReply(query, config, body.page_path ? pagePath(body.page_path, config) : null));
}

export async function handleBuyerRequest(request, env, config, { fetchFn = fetch, executionContext } = {}) {
  const pathname = new URL(request.url).pathname.replace(/\/+$/, '');
  if (!pathname.startsWith('/api/buyer')) return null;
  try {
    if (!config || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(config.siteSlug)) {
      throw new HttpError(503, 'SITE_NOT_CONFIGURED', 'This edition is not configured.');
    }
    if (pathname === '/api/buyer/config' && request.method === 'GET') {
      return json({
        site_slug: config.siteSlug,
        enquiries: Boolean(config.enquiriesEnabled && dbReady(env)),
        assistant: Boolean(config.enquiriesEnabled && dbReady(env) && sourcingBase(env)),
        assistant_mode: config.enquiriesEnabled && dbReady(env) && sourcingBase(env) ? 'connected' : 'source-guide',
        source_guide: Array.isArray(config.sourceRecords) && config.sourceRecords.length > 0,
        consent_version: consentVersion,
      });
    }
    if (pathname === '/api/buyer/enquiries' && request.method === 'POST') return await saveEnquiry(request, env, config, executionContext);
    if (pathname === '/api/buyer/assistant' && request.method === 'POST') return await answerQuestion(request, env, config, fetchFn);
    if (pathname === '/api/buyer/source-guide' && request.method === 'POST') return await sourceGuide(request, env, config);
    const owner = pathname.match(/^\/api\/buyer\/admin\/enquiries(?:\/([0-9a-f-]+))?$/);
    if (owner) return await ownerEnquiries(request, env, config, owner[1]);
    throw new HttpError(404, 'ENDPOINT_NOT_FOUND', 'This endpoint was not found.');
  } catch (error) {
    if (error instanceof HttpError) {
      return json({ error: { code: error.code, message: error.message } }, error.status, error.status === 429 ? { 'Retry-After': String(error.retryAfter || 60) } : {});
    }
    // Do not include upstream bodies, questions, contacts, SQL or credentials in public errors/logs.
    return json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'The service is temporarily unavailable. Your draft remains on this page.' } }, 503);
  }
}

export function createGateway(config, options = {}) {
  return {
    async fetch(request, env, ctx) {
      const response = await handleBuyerRequest(request, env, config, { ...options, executionContext: ctx });
      if (response) return response;
      if (env.ASSETS && typeof env.ASSETS.fetch === 'function') return env.ASSETS.fetch(request);
      return new Response('Not found', { status: 404 });
    },
  };
}
