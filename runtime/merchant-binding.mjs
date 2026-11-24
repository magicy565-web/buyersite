import { IDENTIFIER, httpsUrl } from './merchant-common.mjs';

// A Worker serves one edition. Neither a browser argument nor an OAuth claim can
// select a different merchant, Chatwoot origin, account or inbox.
export function readMerchantBinding(config, env, { requirePublic = true } = {}) {
  if (!config || env?.BUYERSITE_MERCHANT_SUPPORT_ENABLED !== 'true' ||
      (requirePublic && config.publication !== 'public')) return null;
  let value;
  try {
    const raw = env.BUYERSITE_MERCHANT_CONFIG;
    if (typeof raw !== 'string' || raw.length > 8192) return null;
    value = JSON.parse(raw);
  } catch { return null; }
  if (!value || value.version !== 1 || value.authorized !== true ||
      !IDENTIFIER.test(value.merchantId ?? '') || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value.siteSlug ?? '') || value.siteSlug !== config.siteSlug ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || /[\u0000-\u001f\u007f]/.test(value.name) ||
      typeof value.authorizationRef !== 'string' || !value.authorizationRef.trim() || value.authorizationRef.length > 200 ||
      (value.knowledgeRevision != null && !/^[a-f0-9]{64}$/.test(value.knowledgeRevision))) return null;
  const origin = httpsUrl(value.origin, { originOnly: true });
  const privacyUrl = httpsUrl(value.privacyUrl);
  if (!origin || origin !== httpsUrl(config.origin, { originOnly: true }) || !privacyUrl || new URL(privacyUrl).origin !== origin) return null;
  let chatwoot = null;
  if (value.chatwoot) {
    const cw = value.chatwoot;
    const baseUrl = httpsUrl(cw.baseUrl, { originOnly: true });
    const ids = [cw.accountId, cw.websiteInboxId, cw.apiInboxId];
    if (!baseUrl || ids.some(id => !Number.isSafeInteger(id) || id <= 0) || cw.websiteInboxId === cw.apiInboxId) return null;
    chatwoot = Object.freeze({ baseUrl, accountId: cw.accountId, websiteInboxId: cw.websiteInboxId, apiInboxId: cw.apiInboxId });
  }
  return Object.freeze({ merchantId: value.merchantId, siteSlug: value.siteSlug,
    name: value.name.trim(), origin, privacyUrl, authorizationRef: value.authorizationRef.trim(), chatwoot,
    ...(value.knowledgeRevision ? { knowledgeRevision: value.knowledgeRevision } : {}) });
}

export function publicMerchant(merchant) {
  return { merchant_id: merchant.merchantId, site_slug: merchant.siteSlug, name: merchant.name,
    website: merchant.origin, privacy_url: merchant.privacyUrl, consent_version: 'merchant-support-v1' };
}
