import { authorizedOwner } from './gateway.mjs';
import { readMerchantBinding, publicMerchant } from './merchant-binding.mjs';
import { MerchantError, errorResponse, field, json, readJson } from './merchant-common.mjs';
import { MerchantDataError, createMerchantKnowledgeRepository } from './merchant-knowledge.mjs';
import { createMerchantOnboardingRepository } from './merchant-onboarding.mjs';
import { createMerchantChatwootClient } from './merchant-chatwoot.mjs';
import { createD1MerchantAgentBotStore, createMerchantAgentBot } from './merchant-agentbot.mjs';
import { createMerchantSupportService } from './merchant-support-service.mjs';
import { createMerchantMcp } from './merchant-mcp.mjs';
import { createMerchantOAuthVerifier } from './merchant-oauth.mjs';
import { createMerchantAnswerProvider } from './merchant-answer-provider.mjs';
import { pruneMerchantQueue } from './merchant-maintenance.mjs';
import { createMerchantReconciliation } from './merchant-reconciliation.mjs';

const ADMIN = '/api/buyer/admin/merchant-support';
const PUBLIC = new Set(['/mcp', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/api/buyer/support/merchant', '/api/buyer/support/webhook']);
const COMMERCIAL = new Set(['price', 'availability', 'moq', 'lead_time', 'certification']);
const credential = (value, min = 16) => typeof value === 'string' && value.length >= min && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value);
const ENV_KEYS = ['BUYERSITE_MERCHANT_SUPPORT_ENABLED', 'BUYERSITE_MERCHANT_CONFIG', 'BUYERSITE_CHATWOOT_API_TOKEN', 'BUYERSITE_CHATWOOT_AGENTBOT_TOKEN', 'BUYERSITE_CHATWOOT_WEBHOOK_SECRET', 'BUYERSITE_CHATWOOT_AGENTBOT_ID', 'BUYERSITE_MERCHANT_OAUTH_ISSUER', 'BUYERSITE_MERCHANT_OAUTH_JWKS_URI', 'BUYERSITE_MERCHANT_ANSWER_URL', 'BUYERSITE_MERCHANT_ANSWER_TOKEN'];

export function agentKnowledge(bundle) {
  if (!bundle || !bundle.facts.length || bundle.facts.length > 500) return null;
  return { approved: true, merchantId: bundle.merchant_id, revision: bundle.revision,
    facts: bundle.facts.map(fact => ({ id: fact.evidence_id, text: `${fact.claim}: ${fact.value}`, sourceUrl: fact.source_url,
      validUntil: fact.valid_until,
      commercialApproved: COMMERCIAL.has(fact.kind) && ['merchant-confirmed', 'independently-verified'].includes(fact.status) && Boolean(fact.valid_until) })) };
}

function knownError(error) {
  if (error instanceof MerchantDataError) return json({ error: { code: error.code, message: 'The merchant record could not be changed. Check its revision, evidence and fields.' } }, error.status);
  if (['OWNER_AUTH_REQUIRED', 'INBOX_UNAVAILABLE'].includes(error?.code)) return json({ error: { code: error.code, message: 'Owner authentication and a connected database are required.' } }, error.status);
  return errorResponse(error);
}

/** One edition per Worker. Public endpoints never select a merchant from Host or arguments. */
export function createMerchantRoutes(config, { fetchFn = fetch, now = Date.now, verifyAccessToken: injectedVerifier } = {}) {
  let cache = null;
  function components(env) {
    const stamp = JSON.stringify(ENV_KEYS.map(key => env[key] ?? null));
    if (cache?.db === env.DB && cache.stamp === stamp) return cache.value;
    const merchant = readMerchantBinding(config, env, { requirePublic: false });
    if (!merchant) throw new MerchantError(503, 'MERCHANT_NOT_CONFIGURED', 'An authorized merchant has not been connected to this edition.');
    if (!env.DB?.prepare || !env.DB?.batch) throw new MerchantError(503, 'MERCHANT_DATABASE_UNAVAILABLE', 'The merchant database is unavailable.');
    const knowledge = createMerchantKnowledgeRepository(env.DB, merchant);
    const onboarding = createMerchantOnboardingRepository(env.DB, merchant);
    const apiConfigured = Boolean(merchant.chatwoot && credential(env.BUYERSITE_CHATWOOT_API_TOKEN));
    const botId = Number(env.BUYERSITE_CHATWOOT_AGENTBOT_ID);
    const botConfigured = Boolean(merchant.chatwoot && credential(env.BUYERSITE_CHATWOOT_AGENTBOT_TOKEN) && credential(env.BUYERSITE_CHATWOOT_WEBHOOK_SECRET, 32) && Number.isSafeInteger(botId) && botId > 0);
    const client = merchant.chatwoot && (apiConfigured || botConfigured) ? createMerchantChatwootClient({ merchant,
      apiToken: env.BUYERSITE_CHATWOOT_API_TOKEN, agentBotToken: env.BUYERSITE_CHATWOOT_AGENTBOT_TOKEN, fetchFn }) : null;
    const service = createMerchantSupportService({ db: env.DB, merchant, chatwoot: apiConfigured ? client : null, knowledge, now });
    const reconcile = createMerchantReconciliation({ db: env.DB, merchant, chatwoot: apiConfigured ? client : null, now });
    const answer = createMerchantAnswerProvider(env, { fetchFn });
    const store = createD1MerchantAgentBotStore(env.DB);
    const bot = botConfigured ? createMerchantAgentBot({ merchant, client, store, webhookSecret: env.BUYERSITE_CHATWOOT_WEBHOOK_SECRET,
      agentBotId: botId, now, answer: answer ?? undefined,
      loadKnowledge: async () => agentKnowledge(await knowledge.getActive({ now: now() })), canAutomate: service.canAutomate }) : null;
    let verifier = null; let issuer = null;
    if (env.BUYERSITE_MERCHANT_OAUTH_ISSUER && env.BUYERSITE_MERCHANT_OAUTH_JWKS_URI) {
      issuer = env.BUYERSITE_MERCHANT_OAUTH_ISSUER;
      verifier = injectedVerifier ?? createMerchantOAuthVerifier({ issuer, audience: `${merchant.origin}/mcp`,
        jwksUri: env.BUYERSITE_MERCHANT_OAUTH_JWKS_URI, fetchFn, now });
    }
    const mcp = createMerchantMcp({ resource: `${merchant.origin}/mcp`, merchantId: merchant.merchantId,
      authorizationServer: issuer, verifyAccessToken: verifier, service });
    const value = { db: env.DB, merchant, knowledge, onboarding, client, service, reconcile, store, bot, mcp, apiConfigured, botConfigured,
      oauthConfigured: Boolean(verifier), answerConfigured: Boolean(answer) };
    cache = { db: env.DB, stamp, value };
    return value;
  }

  async function drain(value, maxJobs = 1) {
    const redactedJobs = value.merchant.chatwoot ? await pruneMerchantQueue(value.db, value.merchant, { now: now() }) : 0;
    if (!value.bot) return { status: 'needs_connection', results: [], redactedJobs };
    const results = [];
    for (let index = 0; index < Math.min(3, Math.max(1, maxJobs)); index++) {
      const result = await value.bot.processNext(); results.push(result);
      if (result.status === 'idle') break;
    }
    return { status: 'processed', results, redactedJobs };
  }

  async function fetchRequest(request, env, ctx) {
    const url = new URL(request.url); const path = url.pathname;
    const admin = path === ADMIN || path.startsWith(ADMIN + '/');
    if (!admin && !PUBLIC.has(path)) return null;
    try {
      // Do not trust forwarded headers or the URL of an alternate host.
      if (url.origin !== config.origin || (request.headers.has('origin') && request.headers.get('origin') !== config.origin)) throw new MerchantError(403, 'ORIGIN_REJECTED', 'Use the merchant service at its configured address.');
      if (admin) await authorizedOwner(request, env);
      else if (config.publication !== 'public') throw new MerchantError(503, 'PRIVATE_EDITION', 'Customer support is not published for this edition.');
      const value = components(env); const { merchant, knowledge, onboarding, service } = value;
      if (!admin) {
        if (path === '/api/buyer/support/merchant') {
          if (request.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'GET' });
          return json({ merchant: publicMerchant(merchant), capabilities: { publicKnowledge: Boolean((await knowledge.getActive({ now: now() }))?.facts.length),
            customerConversations: value.apiConfigured && value.oauthConfigured }, nativeClaimVerified: false });
        }
        if (path === '/api/buyer/support/webhook') {
          if (!value.bot) throw new MerchantError(503, 'AGENTBOT_NOT_CONFIGURED', 'The signed merchant AgentBot channel is not configured.');
          const accepted = await value.bot.intake(request);
          if (accepted.status === 202 && typeof ctx?.waitUntil === 'function') ctx.waitUntil(drain(value).catch(() => ({ status: 'worker_failed' })));
          return accepted;
        }
        return await value.mcp.fetch(request);
      }
      const route = path.slice(ADMIN.length);
      if (request.method === 'GET' && route === '') {
        const active = await knowledge.getActive({ now: now() });
        const botJobs = merchant.chatwoot ? (await env.DB.prepare(`SELECT status, COUNT(*) AS count FROM merchant_agentbot_jobs
          WHERE site_slug = ? AND merchant_id = ? AND chatwoot_origin = ? AND account_id = ? AND inbox_id IN (?, ?) GROUP BY status`)
          .bind(merchant.siteSlug, merchant.merchantId, merchant.chatwoot.baseUrl, merchant.chatwoot.accountId, merchant.chatwoot.websiteInboxId, merchant.chatwoot.apiInboxId).all()).results : [];
        return json({ merchant: publicMerchant(merchant), publication: config.publication,
          configured: { chatwootApi: value.apiConfigured, signedAgentBot: value.botConfigured, answerProvider: value.answerConfigured, oauth: value.oauthConfigured },
          liveConnectionVerified: false, knowledge: active ? { revision: active.revision, currentFacts: active.facts.length } : null,
          onboarding: await onboarding.get(), support: await service.diagnostics(), agentBotJobs: botJobs });
      }
      if (request.method === 'GET' && route === '/claim-pack') return json(await onboarding.preparePack(await knowledge.getActive({ now: now() }), { now: now() }));
      const writeRoutes = new Set(['/knowledge', '/knowledge/activate', '/claim-evidence', '/drain', '/reconcile']);
      if (!writeRoutes.has(route)) return json({ error: 'NOT_FOUND' }, 404);
      if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'POST' });
      const actorId = field(env.BUYERSITE_MERCHANT_OWNER_ID, 'configured owner identity', 160);
      const input = await readJson(request, route === '/knowledge' ? 512000 : 32768);
      if (route === '/knowledge') return json(await knowledge.saveVersion(input, { actorId, now: now() }), 201);
      if (route === '/knowledge/activate') {
        if (Object.keys(input).some(key => !['revision', 'expectedRevision'].includes(key))) throw new MerchantError(400, 'INVALID_FIELD', 'Provide only the knowledge and expected revisions.');
        return json(await knowledge.activateVersion(input.revision, { expectedRevision: input.expectedRevision, actorId, now: now() }));
      }
      if (route === '/claim-evidence') {
        const { expectedRevision, ...evidence } = input;
        const active = await knowledge.getActive({ now: now() });
        return json(await onboarding.recordEvidence(evidence, { actorId, expectedRevision, activeKnowledgeRevision: active?.revision ?? null, now: now() }));
      }
      if (route === '/reconcile') return json(await value.reconcile(input, { actorId }));
      if (Object.keys(input).length) throw new MerchantError(400, 'INVALID_FIELD', 'Send an empty JSON object for one queue drain.');
      return json(await drain(value));
    } catch (error) { return knownError(error); }
  }
  async function scheduled(env) {
    if (config.publication !== 'public' || env.BUYERSITE_MERCHANT_SUPPORT_ENABLED !== 'true') return { status: 'disabled' };
    try { return await drain(components(env), 3); } catch { return { status: 'worker_failed' }; }
  }
  return { fetch: fetchRequest, scheduled };
}
