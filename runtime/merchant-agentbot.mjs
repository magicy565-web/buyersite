import { validateMerchantChatwootBinding } from './merchant-chatwoot.mjs';

const encoder = new TextEncoder();
const TERMINAL_CONTROL = new Set(['HUMAN_HAS_CONTROL', 'AGENTBOT_ASSIGNMENT_CHANGED', 'MESSAGE_SUPERSEDED']);
const BINDING_ERRORS = new Set(['CHATWOOT_BINDING_MISMATCH', 'CHATWOOT_CONTACT_MISMATCH', 'INVALID_CHATWOOT_CONTACT']);
const COMMERCIAL = /(?:[$€£¥￥]\s*\d|\b(?:USD|EUR|GBP|CNY|RMB)\b|\b(?:prices?|pricing|quotes?|costs?|discounts?|MOQ|minimum\s+order|lead\s*[- ]?time|deliver\w*|shipping|ships?|stocks?|guarantee\w*|warrant\w*|certif\w*|refund\w*|payment|deposit|return\s+policy)\b|价格|报价|优惠|折扣|起订|交期|库存|保证|承诺|认证|退款|退货|付款|定金|发货|交货|到货|包邮)/iu;

function json(value, status = 200, extra = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra } });
}
function validId(value) { return Number.isSafeInteger(value) && value > 0; }
function errorCode(error) { return typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'INTERNAL_ERROR'; }
function hex(bytes) { return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''); }
async function digest(value) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))); }

async function readBoundedBody(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) throw Object.assign(new Error('body'), { code: 'BODY_TOO_LARGE' });
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw Object.assign(new Error('body'), { code: 'BODY_TOO_LARGE' }); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const value of chunks) { result.set(value, offset); offset += value.length; }
  return result;
}

export async function verifyChatwootWebhook({ rawBody, headers, secret, now = Date.now(), maxAgeSeconds = 300 }) {
  if (typeof secret !== 'string' || secret.length < 32 || secret.length > 4096) return false;
  const timestamp = headers.get('X-Chatwoot-Timestamp');
  const signature = headers.get('X-Chatwoot-Signature');
  if (!/^[1-9][0-9]{8,11}$/.test(timestamp ?? '') || !/^sha256=[0-9a-f]{64}$/i.test(signature ?? '')) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(now / 1000) - seconds) > Math.min(900, Math.max(1, maxAgeSeconds))) return false;
  const prefix = encoder.encode(timestamp + '.');
  const data = new Uint8Array(prefix.length + rawBody.length);
  data.set(prefix); data.set(rawBody, prefix.length);
  const expected = new Uint8Array(signature.slice(7).match(/../g).map(byte => Number.parseInt(byte, 16)));
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, expected, data);
}

function decodeRow(row) {
  if (!row) return null;
  return { ...row, payload: JSON.parse(row.payload_json), answer: row.answer_json ? JSON.parse(row.answer_json) : null };
}

function sqlScope({ merchantId, siteSlug, chatwootOrigin, accountId, inboxIds }, alias = '') {
  if (typeof merchantId !== 'string' || !merchantId || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(siteSlug ?? '') || !validId(accountId) || !Array.isArray(inboxIds) || !inboxIds.length || inboxIds.length > 2 || inboxIds.some(id => !validId(id))) throw new Error('INVALID_JOB_SCOPE');
  try { if (new URL(chatwootOrigin).origin !== chatwootOrigin || !chatwootOrigin.startsWith('https://')) throw new Error(); }
  catch { throw new Error('INVALID_JOB_SCOPE'); }
  const ids = [...new Set(inboxIds)];
  return {
    where: `${alias}site_slug=? AND ${alias}merchant_id=? AND ${alias}chatwoot_origin=? AND ${alias}account_id=? AND ${alias}inbox_id IN (${ids.map(() => '?').join(',')})`,
    args: [siteSlug, merchantId, chatwootOrigin, accountId, ...ids],
  };
}
function rowScope(job) { return sqlScope({ merchantId: job.merchant_id, siteSlug: job.site_slug, chatwootOrigin: job.chatwoot_origin, accountId: job.account_id, inboxIds: [job.inbox_id] }); }

/** Durable D1/SQLite store. Migrations are deliberately external to this module. */
export function createD1MerchantAgentBotStore(db) {
  if (!db?.prepare) throw new Error('AGENTBOT_STORE_NOT_CONFIGURED');
  async function enqueue(job) {
    sqlScope({ ...job, inboxIds: [job.inboxId] });
    const inserted = await db.prepare("INSERT INTO merchant_agentbot_jobs (id,merchant_id,site_slug,chatwoot_origin,account_id,inbox_id,conversation_id,message_id,payload_hash,payload_json,delivery_id,status,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?) ON CONFLICT(site_slug,merchant_id,chatwoot_origin,account_id,inbox_id,message_id) DO NOTHING RETURNING id")
      .bind(job.id, job.merchantId, job.siteSlug, job.chatwootOrigin, job.accountId, job.inboxId, job.conversationId, job.messageId, job.payloadHash, JSON.stringify(job.payload), job.deliveryId, job.now, job.now, job.now).first();
    if (inserted) return { id: inserted.id, duplicate: false, conflict: false };
    const existing = await db.prepare('SELECT id,payload_hash FROM merchant_agentbot_jobs WHERE site_slug=? AND merchant_id=? AND chatwoot_origin=? AND account_id=? AND inbox_id=? AND message_id=?')
      .bind(job.siteSlug, job.merchantId, job.chatwootOrigin, job.accountId, job.inboxId, job.messageId).first();
    if (!existing) throw new Error('AGENTBOT_ENQUEUE_FAILED');
    return { id: existing.id, duplicate: true, conflict: existing.payload_hash !== job.payloadHash };
  }

  async function claim({ now, leaseMs = 120_000, ...scope }) {
    const plain = sqlScope(scope);
    const candidate = sqlScope(scope, 'j.');
    // A crashed pre-send worker can be reclaimed. A possibly sent reply must be reconciled.
    await db.prepare(`UPDATE merchant_agentbot_jobs SET status=CASE WHEN status='sending' THEN 'unknown' ELSE 'queued' END, reason=CASE WHEN status='sending' THEN 'DELIVERY_UNKNOWN' ELSE COALESCE(reason,'LEASE_EXPIRED') END, next_attempt_at=?, updated_at=? WHERE ${plain.where} AND status IN ('processing','sending') AND lease_until<=?`)
      .bind(now, now, ...plain.args, now).run();
    const leaseToken = crypto.randomUUID();
    // One atomic claim also serializes each conversation, including retry backoff.
    const row = await db.prepare(`UPDATE merchant_agentbot_jobs SET status='processing',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=? WHERE id=(SELECT j.id FROM merchant_agentbot_jobs j WHERE ${candidate.where} AND j.status='queued' AND j.next_attempt_at<=? AND NOT EXISTS (SELECT 1 FROM merchant_agentbot_jobs p WHERE p.site_slug=j.site_slug AND p.merchant_id=j.merchant_id AND p.chatwoot_origin=j.chatwoot_origin AND p.account_id=j.account_id AND p.inbox_id=j.inbox_id AND p.conversation_id=j.conversation_id AND p.id<>j.id AND (p.status IN ('processing','sending','unknown','dead') OR (p.status='queued' AND (p.message_id<j.message_id OR (p.message_id=j.message_id AND p.created_at<j.created_at))))) ORDER BY j.created_at,j.message_id LIMIT 1) RETURNING *`)
      .bind(leaseToken, now + leaseMs, now, ...candidate.args, now).first();
    return decodeRow(row);
  }

  async function markHandoff(job, reason, now) {
    const scoped = rowScope(job);
    const result = await db.prepare(`UPDATE merchant_agentbot_jobs SET action='handoff',reason=?,updated_at=? WHERE id=? AND ${scoped.where} AND status='processing' AND lease_token=? AND lease_until>?`)
      .bind(reason, now, job.id, ...scoped.args, job.lease_token, now).run();
    return result.meta?.changes === 1;
  }

  async function beginSend(job, answer, now) {
    const scoped = rowScope(job);
    const result = await db.prepare(`UPDATE merchant_agentbot_jobs SET status='sending',answer_json=?,knowledge_revision=?,updated_at=? WHERE id=? AND ${scoped.where} AND status='processing' AND lease_token=? AND lease_until>?`)
      .bind(JSON.stringify(answer), answer.knowledgeRevision, now, job.id, ...scoped.args, job.lease_token, now).run();
    return result.meta?.changes === 1;
  }

  async function canSend(job, now) {
    const scoped = rowScope(job);
    return Boolean(await db.prepare(`SELECT id FROM merchant_agentbot_jobs WHERE id=? AND ${scoped.where} AND status='sending' AND lease_token=? AND lease_until>?`)
      .bind(job.id, ...scoped.args, job.lease_token, now).first());
  }

  async function cancelSend(job, reason, now) {
    const scoped = rowScope(job);
    // Only call after the client's pre-POST callback vetoed the request. A transport
    // error cannot take this path because it cannot prove that nothing was sent.
    const result = await db.prepare(`UPDATE merchant_agentbot_jobs SET status='processing',action='handoff',reason=?,updated_at=? WHERE id=? AND ${scoped.where} AND status='sending' AND lease_token=? AND lease_until>?`)
      .bind(reason, now, job.id, ...scoped.args, job.lease_token, now).run();
    return result.meta?.changes === 1;
  }

  async function finish(job, { status, reason = null, sentMessageId = null, now }) {
    const scoped = rowScope(job);
    if (!['delivered','handed_off','ignored','unknown','dead'].includes(status)) throw new Error('INVALID_JOB_STATUS');
    if (status === 'delivered' && !validId(sentMessageId)) throw new Error('INVALID_SENT_MESSAGE_ID');
    // A late definitive HTTP success may resolve our own unknown lease, never another worker's.
    const result = await db.prepare(`UPDATE merchant_agentbot_jobs SET status=?,reason=?,sent_message_id=?,lease_until=NULL,updated_at=? WHERE id=? AND ${scoped.where} AND lease_token=? AND (status IN ('processing','sending') OR (status='unknown' AND ?='delivered'))`)
      .bind(status, reason, sentMessageId, now, job.id, ...scoped.args, job.lease_token, status).run();
    return result.meta?.changes === 1;
  }

  async function retry(job, { reason, now, maxAttempts = 5 }) {
    const scoped = rowScope(job);
    const status = job.attempts >= maxAttempts ? 'dead' : 'queued';
    const delay = Math.min(300_000, 1000 * 2 ** Math.min(8, job.attempts));
    await db.prepare(`UPDATE merchant_agentbot_jobs SET status=?,reason=?,next_attempt_at=?,lease_until=NULL,updated_at=? WHERE id=? AND ${scoped.where} AND status='processing' AND lease_token=?`)
      .bind(status, reason, now + delay, now, job.id, ...scoped.args, job.lease_token).run();
    return status;
  }

  async function get({ jobId, ...scope }) {
    const scoped = sqlScope(scope);
    return decodeRow(await db.prepare(`SELECT * FROM merchant_agentbot_jobs WHERE ${scoped.where} AND id=?`).bind(...scoped.args, jobId).first());
  }

  async function reconcile({ jobId, resolution, sentMessageId = null, reason, now = Date.now(), ...scope }) {
    const scoped = sqlScope(scope);
    if (!['delivered','handed_off','ignored'].includes(resolution) || typeof reason !== 'string' || !reason.trim() || reason.length > 240 || (resolution === 'delivered' && !validId(sentMessageId))) throw new Error('INVALID_RECONCILIATION');
    // Caller must authenticate an operator and verify external evidence before invoking this.
    const result = await db.prepare(`UPDATE merchant_agentbot_jobs SET status=?,reason=?,sent_message_id=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE ${scoped.where} AND id=? AND status IN ('unknown','dead')`)
      .bind(resolution, reason, sentMessageId, now, ...scoped.args, jobId).run();
    return result.meta?.changes === 1;
  }

  return Object.freeze({ enqueue, claim, markHandoff, beginSend, canSend, cancelSend, finish, retry, get, reconcile });
}

function eventPayload(raw, binding) {
  if (raw?.account?.id !== binding.accountId || ![binding.websiteInboxId, binding.apiInboxId].filter(Boolean).includes(raw?.inbox?.id ?? raw?.inbox_id)) return { error: 'WEBHOOK_TENANT_MISMATCH' };
  if (raw.event !== 'message_created' || raw.message_type !== 'incoming' || raw.private !== false) return { ignored: true };
  const conversation = raw.conversation;
  if (!validId(raw.id) || !validId(conversation?.id) || conversation.inbox_id !== raw.inbox.id || conversation.account?.id !== binding.accountId ||
      raw.sender?.type !== 'contact' || !validId(raw.sender?.id) || raw.sender.id !== conversation.meta?.sender?.id) return { error: 'INVALID_WEBHOOK_MESSAGE' };
  if (typeof raw.content !== 'string' && raw.content !== null) return { error: 'INVALID_WEBHOOK_CONTENT' };
  if ((raw.content?.length ?? 0) > 6000) return { error: 'WEBHOOK_CONTENT_TOO_LARGE' };
  return { payload: {
    event: 'message_created', accountId: binding.accountId, inboxId: raw.inbox.id, conversationId: conversation.id,
    message: { id: raw.id, content: raw.content ?? '', contactId: raw.sender.id, createdAt: typeof raw.created_at === 'string' ? raw.created_at : null, hasAttachments: Array.isArray(raw.attachments) && raw.attachments.length > 0 },
  } };
}

function approvedKnowledge(knowledge, merchant) {
  if (knowledge?.approved !== true || knowledge.merchantId !== merchant.merchantId || typeof knowledge.revision !== 'string' || !knowledge.revision || knowledge.revision.length > 200 || !Array.isArray(knowledge.facts) || !knowledge.facts.length || knowledge.facts.length > 500) return false;
  const ids = new Set();
  for (const fact of knowledge.facts) {
    if (typeof fact?.id !== 'string' || !fact.id || ids.has(fact.id) || typeof fact.text !== 'string' || !fact.text.trim() || fact.text.length > 8000) return false;
    ids.add(fact.id);
    try { const url = new URL(fact.sourceUrl); if (url.protocol !== 'https:' || url.username || url.password) return false; } catch { return false; }
  }
  return true;
}

function answerRejection(candidate, knowledge, message, now, minConfidence) {
  if (candidate?.needsHuman !== false || !Number.isFinite(candidate.confidence) || candidate.confidence < minConfidence || candidate.confidence > 1) return 'LOW_CONFIDENCE';
  if (typeof candidate.text !== 'string' || !candidate.text.trim() || candidate.text.length > 6000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(candidate.text)) return 'INVALID_ANSWER';
  if (candidate.knowledgeRevision !== knowledge.revision || !Array.isArray(candidate.evidenceIds) || !candidate.evidenceIds.length || candidate.evidenceIds.some(id => !knowledge.facts.some(fact => fact.id === id))) return 'UNGROUNDED_ANSWER';
  if (!Array.isArray(candidate.unsupportedCommitments) || candidate.unsupportedCommitments.length) return 'UNSUPPORTED_COMMITMENT';
  // Commercial answers must be an exact, current, explicitly approved fact. The model's own
  // assertion that a quotation or delivery promise is supported is not sufficient evidence.
  if (COMMERCIAL.test(message.content) || COMMERCIAL.test(candidate.text)) {
    const fact = knowledge.facts.find(item => item.text.trim() === candidate.text.trim() && candidate.evidenceIds.includes(item.id) && item.commercialApproved === true && Number.isFinite(Date.parse(item.validUntil)) && Date.parse(item.validUntil) > now);
    if (!fact) return 'COMMERCIAL_REQUIRES_HUMAN';
  }
  return null;
}

async function withTimeout(run, milliseconds) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => run(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('provider'), { code: 'PROVIDER_TIMEOUT' })); }, milliseconds); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Intake and worker are separate: intake does no provider calls or outgoing messages. */
export function createMerchantAgentBot({ merchant, webhookSecret, store, client, answer, loadKnowledge, canAutomate, agentBotId, now = Date.now, maxAgeSeconds = 300, maxJobAgeMs = 86_400_000, providerTimeoutMs = 20_000, minConfidence = 0.8 }) {
  const binding = validateMerchantChatwootBinding(merchant);
  const providerTimeout = Math.min(45_000, Math.max(10, Number(providerTimeoutMs) || 20_000));
  const confidenceThreshold = Math.min(1, Math.max(0.8, Number(minConfidence) || 0.8));
  const maximumJobAge = Math.min(7 * 86_400_000, Math.max(1000, Number(maxJobAgeMs) || 86_400_000));
  async function automationAllowed(conversationId) {
    if (typeof canAutomate !== 'function') return true;
    try { return await withTimeout(() => canAutomate(conversationId), 5000) === true; } catch { return false; }
  }

  async function intake(request) {
    if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'POST' });
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) return json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
    let rawBody;
    try { rawBody = await readBoundedBody(request, 128 * 1024); }
    catch (error) { return json({ error: errorCode(error) }, error.code === 'BODY_TOO_LARGE' ? 413 : 400); }
    if (!await verifyChatwootWebhook({ rawBody, headers: request.headers, secret: webhookSecret, now: now(), maxAgeSeconds })) return json({ error: 'INVALID_WEBHOOK_SIGNATURE' }, 401);
    let raw;
    try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); } catch { return json({ error: 'INVALID_JSON' }, 400); }
    const parsed = eventPayload(raw, binding);
    if (parsed.error) return json({ error: parsed.error }, parsed.error === 'WEBHOOK_TENANT_MISMATCH' ? 403 : 400);
    if (parsed.ignored) return json({ accepted: true, ignored: true });
    const payload = parsed.payload;
    const delivery = request.headers.get('X-Chatwoot-Delivery');
    const deliveryId = delivery && /^[A-Za-z0-9_-]{1,160}$/.test(delivery) ? delivery : null;
    try {
      const receipt = await store.enqueue({ id: crypto.randomUUID(), merchantId: merchant.merchantId, siteSlug: merchant.siteSlug, chatwootOrigin: binding.baseUrl, accountId: binding.accountId, inboxId: payload.inboxId, conversationId: payload.conversationId, messageId: payload.message.id, payload, payloadHash: await digest(JSON.stringify(payload)), deliveryId, now: now() });
      if (receipt.conflict) return json({ error: 'WEBHOOK_MESSAGE_CONFLICT' }, 409);
      return json({ accepted: true, duplicate: receipt.duplicate, jobId: receipt.id }, 202);
    } catch {
      // Chatwoot's AgentBot retry job retries 429/500, not every 5xx code.
      return json({ error: 'AGENTBOT_STORE_UNAVAILABLE' }, 500);
    }
  }

  async function terminal(job, status, reason, sentMessageId = null) {
    await store.finish(job, { status, reason, sentMessageId, now: now() });
    return { status, jobId: job.id, ...(reason ? { reason } : {}), ...(sentMessageId ? { messageId: sentMessageId } : {}) };
  }

  async function handoff(job, reason) {
    if (!await store.markHandoff(job, reason, now())) return { status: 'lease_lost', jobId: job.id };
    try {
      const result = await client.requestHuman({ conversationId: job.conversation_id, contactId: job.payload.message.contactId });
      return terminal(job, result.status === 'open' ? 'handed_off' : 'ignored', result.status === 'open' ? reason : 'CONVERSATION_NOT_PENDING');
    } catch (error) {
      if (BINDING_ERRORS.has(error.code) || [401, 403, 404].includes(error.status)) return terminal(job, 'dead', errorCode(error));
      const status = await store.retry(job, { reason: errorCode(error), now: now() });
      return { status: status === 'queued' ? 'retry' : status, jobId: job.id, reason: errorCode(error) };
    }
  }

  async function processNext() {
    const job = await store.claim({ merchantId: merchant.merchantId, siteSlug: merchant.siteSlug, chatwootOrigin: binding.baseUrl, accountId: binding.accountId, inboxIds: [binding.apiInboxId, binding.websiteInboxId].filter(Boolean), now: now(), leaseMs: 120_000 });
    if (!job) return { status: 'idle' };
    if (job.account_id !== binding.accountId || ![binding.apiInboxId, binding.websiteInboxId].includes(job.inbox_id)) return terminal(job, 'ignored', 'MERCHANT_BINDING_CHANGED');
    // Use our durable receipt time, not a sender-supplied event timestamp.
    if (!Number.isFinite(job.created_at) || now() - job.created_at > maximumJobAge || job.created_at - now() > 300_000) return handoff(job, 'JOB_EXPIRED');
    let conversation;
    try { conversation = await client.getConversation({ conversationId: job.conversation_id, contactId: job.payload.message.contactId, asAgent: true }); }
    catch (error) {
      if (BINDING_ERRORS.has(error.code) || [401, 403, 404].includes(error.status)) return terminal(job, 'dead', errorCode(error));
      const status = await store.retry(job, { reason: errorCode(error), now: now() });
      return { status: status === 'queued' ? 'retry' : status, jobId: job.id };
    }
    if (conversation.accountId !== binding.accountId || conversation.inboxId !== job.inbox_id || conversation.contactId !== job.payload.message.contactId) return terminal(job, 'dead', 'CHATWOOT_BINDING_MISMATCH');
    if (conversation.status !== 'pending' || (conversation.assigneeType && conversation.assigneeType !== 'AgentBot')) return terminal(job, 'ignored', 'HUMAN_HAS_CONTROL');
    if (conversation.assigneeType === 'AgentBot' && (!validId(agentBotId) || conversation.assigneeId !== agentBotId)) return terminal(job, 'ignored', 'AGENTBOT_ASSIGNMENT_CHANGED');
    if (conversation.messages?.some(message => message.message_type === 'incoming' && message.id > job.message_id)) return terminal(job, 'ignored', 'MESSAGE_SUPERSEDED');
    if (job.action === 'handoff') return handoff(job, job.reason ?? 'HUMAN_REQUESTED');
    if (!await automationAllowed(job.conversation_id)) return handoff(job, 'HUMAN_REQUESTED');
    if (job.payload.message.hasAttachments || !job.payload.message.content.trim()) return handoff(job, 'UNSUPPORTED_MESSAGE');
    if (typeof answer !== 'function' || typeof loadKnowledge !== 'function') return handoff(job, 'PROVIDER_NOT_CONFIGURED');
    let knowledge;
    try { knowledge = await withTimeout(signal => loadKnowledge({ merchant, message: job.payload.message, conversation, signal }), 10_000); }
    catch { return handoff(job, 'KNOWLEDGE_UNAVAILABLE'); }
    if (!approvedKnowledge(knowledge, merchant)) return handoff(job, 'KNOWLEDGE_NOT_APPROVED');
    let candidate;
    try { candidate = await withTimeout(signal => answer({ merchant, message: job.payload.message, conversation, knowledge, signal }), providerTimeout); }
    catch (error) { return handoff(job, error.code === 'PROVIDER_TIMEOUT' ? 'PROVIDER_TIMEOUT' : 'PROVIDER_ERROR'); }
    const rejected = answerRejection(candidate, knowledge, job.payload.message, now(), confidenceThreshold);
    if (rejected) return handoff(job, rejected);
    if (!await automationAllowed(job.conversation_id)) return handoff(job, 'HUMAN_REQUESTED');
    const prepared = { text: candidate.text.trim(), confidence: candidate.confidence, evidenceIds: [...new Set(candidate.evidenceIds)], knowledgeRevision: knowledge.revision };
    if (!await store.beginSend(job, prepared, now())) return { status: 'lease_lost', jobId: job.id };
    let vetoReason = null;
    const beforeSend = async () => {
      let fresh;
      try { fresh = await withTimeout(signal => loadKnowledge({ merchant, message: job.payload.message, conversation, signal }), 10_000); }
      catch { vetoReason = 'KNOWLEDGE_UNAVAILABLE'; return false; }
      if (!approvedKnowledge(fresh, merchant) || fresh.revision !== knowledge.revision) { vetoReason = 'KNOWLEDGE_CHANGED'; return false; }
      const invalid = answerRejection(candidate, fresh, job.payload.message, now(), confidenceThreshold);
      if (invalid) { vetoReason = invalid; return false; }
      if (!await automationAllowed(job.conversation_id)) { vetoReason = 'HUMAN_REQUESTED'; return false; }
      return store.canSend(job, now());
    };
    try {
      // Client re-reads current pending/assignment immediately before the outgoing POST.
      const sent = await client.sendAgentReply({ conversationId: job.conversation_id, content: prepared.text, inReplyTo: job.message_id, sourceId: `buyersite-agentbot:${job.id}`, expectedAgentBotId: agentBotId, beforeSend });
      return terminal(job, 'delivered', null, sent.id);
    } catch (error) {
      if (error.code === 'HUMAN_HAS_CONTROL' && vetoReason) {
        if (!await store.cancelSend(job, vetoReason, now())) return { status: 'lease_lost', jobId: job.id };
        return handoff(job, vetoReason);
      }
      if (TERMINAL_CONTROL.has(error.code)) return terminal(job, 'ignored', error.code);
      if (error.ambiguous !== false) return terminal(job, 'unknown', 'DELIVERY_UNKNOWN');
      return terminal(job, 'dead', errorCode(error));
    }
  }

  return Object.freeze({ intake, processNext });
}
