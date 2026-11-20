import { sanitizeCampaign, normalizeKnownPath } from '../src/lib/buyer-journey.mjs';
import { enqueueMarketingEvent } from './marketing-outbox.mjs';

const events = new Set(['page_view','article_opened','enquiry_started','enquiry_submitted','assistant_opened','search_used','source_opened']);
const reply = (status) => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function marketingType(name, path, landingPath) {
  if (name === 'page_view') return path === landingPath ? 'landing_view' : 'page_view';
  if (name === 'enquiry_started' || name === 'assistant_opened') return 'cta_click';
  // enquiry_submitted is recorded from the server only after D1 accepts the enquiry.
  return null;
}

export async function handleAnalytics(request, env, config) {
  if (request.method !== 'POST') return reply(405);
  const origin = new URL(request.url).origin;
  if (request.headers.get('origin') !== origin || request.headers.get('sec-fetch-site') === 'cross-site') return reply(403);
  if (!config.analyticsEnabled || !env.DB || request.headers.get('DNT') === '1' || request.headers.get('Sec-GPC') === '1') return reply(204);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return reply(415);
  const reader = request.body?.getReader(); if (!reader) return reply(400);
  let size = 0; const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2048) { await reader.cancel(); return reply(413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let body;
  try {
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return reply(400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400);
  const allowed = new Set(config.allowedPaths.map(path => path.replace(/\/+$/, '') || '/'));
  const path = typeof body.path === 'string' ? body.path.replace(/\/+$/, '') || '/' : '';
  if (!events.has(body.name) || !allowed.has(path) ||
      Object.keys(body).some(key => !['eventId','name','path','campaign','landingPath'].includes(key))) return reply(400);
  let campaign = {};
  try { campaign = sanitizeCampaign(body.campaign, { strict: true }); } catch { return reply(400); }
  const landingPath = body.landingPath == null ? path : normalizeKnownPath(body.landingPath, config.allowedPaths);
  if (!landingPath) return reply(400);
  if (body.eventId !== undefined && (typeof body.eventId !== 'string' || !UUID.test(body.eventId))) return reply(400);
  const now = Date.now(); const minute = Math.floor(now / 60000); const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(config.siteSlug + ':' + minute + ':' + ip)));
  const bucket = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    const rate = await env.DB.prepare("INSERT INTO buyer_rate_limits(site_slug,scope,bucket,window_start,count,expires_at) VALUES (?,'events',?,?,1,?) ON CONFLICT(site_slug,scope,bucket,window_start) DO UPDATE SET count=count+1 WHERE count<60 RETURNING count")
      .bind(config.siteSlug, bucket, minute, Math.floor(now / 1000) + 120).first();
    if (!rate) return reply(429);
    const type = marketingType(body.name, path, landingPath);
    if (type && campaign.campaign) {
      await enqueueMarketingEvent(env, config, {
        eventId: body.eventId ?? crypto.randomUUID(), campaignId: campaign.campaign, type,
        occurredAt: new Date(now).toISOString(), landingUrl: new URL(landingPath, request.url).href,
        pagePath: path, utm: campaign, metadata: { source: 'buyersite', pageType: path.startsWith('/materials/') ? 'article' : path.startsWith('/products/') ? 'product' : path.startsWith('/suppliers/') ? 'supplier' : path.startsWith('/guides/') ? 'guide' : 'other', ...(body.name === 'assistant_opened' || body.name === 'enquiry_started' ? { ctaId: body.name } : {}) },
      });
      // Browser events are batched by the scheduled outbox drain; only a persisted enquiry triggers immediate delivery.
    }
    await env.DB.prepare('INSERT INTO buyer_event_daily(site_slug,day,event,path,count) VALUES(?,?,?,?,1) ON CONFLICT(site_slug,day,event,path) DO UPDATE SET count=count+1')
      .bind(config.siteSlug, new Date(now).toISOString().slice(0, 10), body.name, path).run();
    await env.DB.prepare('DELETE FROM buyer_rate_limits WHERE rowid IN (SELECT rowid FROM buyer_rate_limits WHERE expires_at<? LIMIT 50)')
      .bind(Math.floor(now / 1000)).run();
    return reply(204);
  } catch { return reply(503); }
}
