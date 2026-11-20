const CAMPAIGN_ID = /^cmp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENT_TYPES = new Set(['page_view', 'landing_view', 'cta_click', 'inquiry_submitted', 'qualified_inquiry', 'inquiry_disqualified', 'sample_requested', 'order_created']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();

function boundedLabel(value, max, allowCampaignId = false) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= max && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(text) && (allowCampaignId && CAMPAIGN_ID.test(text) || !/\d{6,}/.test(text)) ? text : null;
}

function campaignLabels(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['source','medium','campaign'].includes(key))) return {};
  const source = boundedLabel(value.source, 32);
  const medium = boundedLabel(value.medium, 32);
  const campaign = boundedLabel(value.campaign, 64, true);
  return { ...(source ? { source } : {}), ...(medium ? { medium } : {}), ...(campaign ? { campaign } : {}) };
}

function connection(env) {
  if (typeof env?.MAUSBOT_MARKETING_WEBHOOK_URL !== 'string' ||
      typeof env?.MAUSBOT_MARKETING_WEBHOOK_SECRET !== 'string' ||
      env.MAUSBOT_MARKETING_WEBHOOK_SECRET.length < 32) return null;
  try {
    const url = new URL(env.MAUSBOT_MARKETING_WEBHOOK_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
        !/\/marketing\/events\/[A-Za-z0-9_-]{1,160}$/.test(url.pathname)) return null;
    return { url, secret: env.MAUSBOT_MARKETING_WEBHOOK_SECRET };
  } catch { return null; }
}

export async function enqueueMarketingEvent(env, config, input) {
  if (!env?.DB || typeof env.DB.prepare !== 'function' || !config?.siteSlug) return false;
  const utm = campaignLabels(input?.utm);
  const campaignId = typeof input?.campaignId === 'string' ? input.campaignId : utm.campaign;
  if (!CAMPAIGN_ID.test(campaignId ?? '') || utm.campaign !== campaignId) return false;
  const eventId = typeof input?.eventId === 'string' ? input.eventId.trim() : '';
  const type = typeof input?.type === 'string' ? input.type : '';
  const occurredAt = typeof input?.occurredAt === 'string' ? input.occurredAt : '';
  if (!eventId || eventId.length > 200 || /[\u0000-\u001f]/.test(eventId) || !EVENT_TYPES.has(type) ||
      !Number.isFinite(Date.parse(occurredAt))) return false;
  let landingUrl = null;
  if (typeof input?.landingUrl === 'string') {
    try {
      const parsed = new URL(input.landingUrl);
      if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.search && !parsed.hash) landingUrl = parsed.toString();
    } catch {}
  }
  const pagePath = typeof input?.pagePath === 'string' && input.pagePath.startsWith('/') && !input.pagePath.startsWith('//') && input.pagePath.length <= 240 && !/[?#\\\\\x00-\x20]/.test(input.pagePath)
    ? input.pagePath : '/';
  const rawMetadata = input?.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata) ? input.metadata : {};
  const metadata = {
    ...(typeof rawMetadata.source === 'string' && rawMetadata.source === 'buyersite' ? { source: rawMetadata.source } : {}),
    ...(typeof rawMetadata.pageType === 'string' && ['article','product','supplier','guide','other'].includes(rawMetadata.pageType) ? { pageType: rawMetadata.pageType } : {}),
    ...(typeof rawMetadata.ctaId === 'string' && ['assistant_opened','enquiry_started'].includes(rawMetadata.ctaId) ? { ctaId: rawMetadata.ctaId } : {}),
    ...(rawMetadata.formType === 'buyer-enquiry' ? { formType: rawMetadata.formType } : {}),
    ...(typeof rawMetadata.attributionMethod === 'string' && ['reported-session','reported-campaign','withheld'].includes(rawMetadata.attributionMethod) ? { attributionMethod: rawMetadata.attributionMethod } : {}),
  };
  const payload = {
    eventId, campaignId, type, occurredAt, landingUrl, pagePath,
    utm,
    ...(typeof input?.inquiryId === 'string' && UUID.test(input.inquiryId) ? { inquiryId: input.inquiryId } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
  };
  const now = Date.now();
  await env.DB.prepare('INSERT INTO buyer_marketing_outbox ' +
    '(id, site_slug, event_id, campaign_id, event_type, payload_json, status, attempts, next_attempt_at, lease_until, created_at, updated_at, delivered_at, last_http_status, last_error) ' +
    "VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, ?, ?, NULL, NULL, NULL) " +
    'ON CONFLICT(site_slug, event_id) DO NOTHING')
    .bind(crypto.randomUUID(), config.siteSlug, eventId, campaignId, type, JSON.stringify(payload),
      now, new Date(now).toISOString(), new Date(now).toISOString()).run();
  return true;
}

async function sign(secret, timestamp, raw) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(timestamp + '.' + raw)));
  return 'sha256=' + Array.from(signature, byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function dispatchMarketingOutbox(env, config, { fetchFn = fetch, now = Date.now(), limit = 10 } = {}) {
  if (!env?.DB || typeof env.DB.prepare !== 'function') return { status: 'unavailable', claimed: 0, delivered: 0, retried: 0, dead: 0 };
  const target = connection(env);
  if (!target) return { status: 'needs_connection', claimed: 0, delivered: 0, retried: 0, dead: 0 };
  const safeLimit = Math.max(1, Math.min(25, Math.trunc(limit)));
  const leaseUntil = now + 60_000;
  const claimed = await env.DB.prepare("UPDATE buyer_marketing_outbox " +
    "SET status='sending', attempts=attempts+1, lease_until=?, updated_at=? " +
    'WHERE id IN (SELECT id FROM buyer_marketing_outbox ' +
    "WHERE (status='pending' AND next_attempt_at<=?) OR (status='sending' AND lease_until<=?) " +
    'ORDER BY created_at ASC LIMIT ?) ' +
    'RETURNING id, payload_json, attempts')
    .bind(leaseUntil, new Date(now).toISOString(), now, now, safeLimit).all();
  const rows = claimed?.results ?? [];
  let delivered = 0, retried = 0, dead = 0;
  for (const row of rows) {
    let outcome = 'retry', httpStatus = null, errorCode = 'network_error', deliveredAt = null;
    try {
      const raw = row.payload_json;
      const timestamp = String(now);
      const signature = await sign(target.secret, timestamp, raw);
      const response = await fetchFn(target.url.toString(), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', 'X-Maus-Timestamp': timestamp, 'X-Maus-Signature': signature },
        body: raw,
      });
      httpStatus = response.status;
      let body = null;
      try { body = await response.json(); } catch {}
      if ((response.status === 200 || response.status === 202) && body?.accepted === true) {
        outcome = 'delivered'; deliveredAt = new Date(now).toISOString(); errorCode = null;
      } else if (response.status >= 500 || [408, 425, 429].includes(response.status)) {
        outcome = 'retry'; errorCode = 'http_' + response.status;
      } else {
        outcome = 'dead'; errorCode = 'http_' + response.status;
      }
    } catch {
      outcome = 'retry'; errorCode = 'network_error';
    }
    const attempts = Number(row.attempts) || 1;
    if (outcome === 'retry' && attempts >= 10) { outcome = 'dead'; errorCode = 'retry_limit'; }
    const status = outcome === 'retry' ? 'pending' : outcome;
    const delay = Math.min(6 * 60 * 60_000, 60_000 * (2 ** Math.min(8, Math.max(0, attempts - 1))));
    await env.DB.prepare('UPDATE buyer_marketing_outbox ' +
      'SET status=?, next_attempt_at=?, lease_until=NULL, updated_at=?, delivered_at=?, last_http_status=?, last_error=? ' +
      "WHERE id=? AND status='sending'")
      .bind(status, now + delay, new Date(now).toISOString(), deliveredAt, httpStatus, errorCode, row.id).run();
    if (outcome === 'delivered') delivered++;
    else if (outcome === 'retry') retried++;
    else dead++;
  }
  return { status: 'connected', claimed: rows.length, delivered, retried, dead };
}

export async function marketingOutboxStatus(env, config) {
  if (!env?.DB || typeof env.DB.prepare !== 'function') return { connection: 'unavailable', pending: null, sending: null, delivered: null, dead: null };
  const rows = await env.DB.prepare('SELECT status, COUNT(*) AS count FROM buyer_marketing_outbox WHERE site_slug=? GROUP BY status')
    .bind(config.siteSlug).all();
  const counts = { pending: 0, sending: 0, delivered: 0, dead: 0 };
  for (const row of rows?.results ?? []) if (Object.hasOwn(counts, row.status)) counts[row.status] = Number(row.count);
  return { connection: connection(env) ? 'connected' : 'needs_connection', ...counts };
}
