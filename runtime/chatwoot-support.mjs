// Public website widget configuration only. Never expose Chatwoot API tokens,
// webhook secrets, agent identifiers, or customer data.
import { readMerchantBinding } from './merchant-binding.mjs';
function origin(value) {
  if (typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
    return u.origin;
  } catch { return null; }
}
export function getChatwootSupport(request, env, config) {
  const disabled = { enabled: false };
  if (env?.BUYERSITE_MERCHANT_CONFIG !== undefined || env?.BUYERSITE_MERCHANT_SUPPORT_ENABLED !== undefined) {
    const merchant = readMerchantBinding(config, env);
    const token = env.BUYERSITE_CHATWOOT_WEBSITE_TOKEN;
    if (!merchant?.chatwoot || new URL(request.url).origin !== merchant.origin || env.BUYERSITE_CHATWOOT_ENABLED !== 'true' ||
        typeof token !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(token)) return disabled;
    return { enabled: true, site_slug: merchant.siteSlug, merchant_id: merchant.merchantId, base_url: merchant.chatwoot.baseUrl,
      website_token: token, merchant_name: merchant.name, privacy_url: merchant.privacyUrl };
  }
  if (config?.publication !== 'public' ||
      env?.BUYERSITE_CHATWOOT_ENABLED !== 'true' ||
      env?.BUYERSITE_CHATWOOT_MERCHANT_AUTHORIZED !== 'true' ||
      typeof config.siteSlug !== 'string' ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(config.siteSlug) ||
      env.BUYERSITE_CHATWOOT_SITE_SLUG !== config.siteSlug) return disabled;
  const siteOrigin = origin(config.origin);
  const boundOrigin = origin(env.BUYERSITE_CHATWOOT_SITE_ORIGIN);
  const baseUrl = origin(env.BUYERSITE_CHATWOOT_BASE_URL);
  const token = env.BUYERSITE_CHATWOOT_WEBSITE_TOKEN;
  const merchant = env.BUYERSITE_CHATWOOT_MERCHANT_NAME;
  if (!siteOrigin || boundOrigin !== siteOrigin || new URL(request.url).origin !== siteOrigin ||
      !baseUrl || typeof token !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(token) ||
      typeof merchant !== 'string' || !merchant.trim() || merchant.length > 120 || /[\u0000-\u001f\u007f]/.test(merchant)) return disabled;
  return { enabled: true, site_slug: config.siteSlug, base_url: baseUrl, website_token: token, merchant_name: merchant.trim() };
}
export function handleChatwootSupport(request, env, config) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' };
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' }), { status: 405, headers: { ...headers, Allow: 'GET' } });
  return new Response(JSON.stringify(getChatwootSupport(request, env, config)), { headers });
}
