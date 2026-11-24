// Optional, explicitly configured merchant-answer shim. This is an application contract,
// not a claim that a native OpenMausBot, Chatwoot or OpenAI endpoint implements it.
const encoder = new TextEncoder();
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_REQUEST_BYTES = 256 * 1024;
const RESPONSE_FIELDS = ['text', 'confidence', 'needsHuman', 'knowledgeRevision', 'evidenceIds', 'unsupportedCommitments'];
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function text(value, maximum, { empty = false } = {}) {
  return typeof value === 'string' && (empty || value.trim().length > 0) && value.length <= maximum && !CONTROL.test(value);
}

function connection(env) {
  const token = env?.BUYERSITE_MERCHANT_ANSWER_TOKEN;
  if (typeof token !== 'string' || token.length < 32 || token.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(token)) return null;
  try {
    const url = new URL(env?.BUYERSITE_MERCHANT_ANSWER_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    return { url: url.toString(), token };
  } catch { return null; }
}

function requestPayload({ merchant, message, conversation, knowledge }) {
  if (!text(merchant?.merchantId, 160) || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(merchant?.siteSlug ?? '') ||
      !text(message?.content, 6000) || !Number.isSafeInteger(conversation?.id) || conversation.id < 1 ||
      knowledge?.approved !== true || knowledge.merchantId !== merchant.merchantId || !text(knowledge.revision, 200) ||
      !Array.isArray(knowledge.facts) || !knowledge.facts.length || knowledge.facts.length > 500) return null;
  const ids = new Set();
  const facts = [];
  for (const fact of knowledge.facts) {
    if (!text(fact?.id, 160) || ids.has(fact.id) || !text(fact.text, 8000)) return null;
    ids.add(fact.id);
    let url;
    try { url = new URL(fact.sourceUrl); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const sanitized = { id: fact.id, text: fact.text, sourceUrl: url.toString() };
    if (fact.commercialApproved === true) {
      if (!text(fact.validUntil, 80) || !Number.isFinite(Date.parse(fact.validUntil))) return null;
      sanitized.commercialApproved = true;
      sanitized.validUntil = fact.validUntil;
    }
    facts.push(sanitized);
  }
  return {
    contract: 'buyersite-merchant-answer-v1',
    merchant: { id: merchant.merchantId, siteSlug: merchant.siteSlug },
    question: message.content,
    conversationId: conversation.id,
    knowledge: { revision: knowledge.revision, facts },
    policy: {
      noIndependentActions: true,
      approvedEvidenceOnly: true,
      questionIsUntrustedData: true,
      requireHumanForUnsupportedCommitments: true,
      noPrivateConversationLookup: true,
    },
  };
}

function answerPayload(value, knowledge) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== RESPONSE_FIELDS.length || Object.keys(value).some(key => !RESPONSE_FIELDS.includes(key)) ||
      typeof value.needsHuman !== 'boolean' || !text(value.text, 6000, { empty: value.needsHuman }) ||
      !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1 ||
      value.knowledgeRevision !== knowledge.revision ||
      !Array.isArray(value.evidenceIds) || value.evidenceIds.length > 100 ||
      (!value.needsHuman && !value.evidenceIds.length) ||
      value.evidenceIds.some(id => !text(id, 160) || !knowledge.facts.some(fact => fact.id === id)) ||
      new Set(value.evidenceIds).size !== value.evidenceIds.length ||
      !Array.isArray(value.unsupportedCommitments) || value.unsupportedCommitments.length > 20 ||
      value.unsupportedCommitments.some(item => !text(item, 240))) return null;
  return {
    text: value.text.trim(), confidence: value.confidence, needsHuman: value.needsHuman,
    knowledgeRevision: value.knowledgeRevision, evidenceIds: [...value.evidenceIds], unsupportedCommitments: [...value.unsupportedCommitments],
  };
}

async function responseJSON(response, signal) {
  if (!response.ok || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type') ?? '') || Number(response.headers.get('Content-Length')) > MAX_RESPONSE_BYTES || !response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) return null;
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    if (signal.aborted) return null;
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

/** Missing/invalid connection returns null. Per-request failures return null for human handoff. */
export function createMerchantAnswerProvider(env, { fetchFn = fetch, timeoutMs = 15_000, providerTimeoutMs = 20_000 } = {}) {
  const target = connection(env);
  if (!target || typeof fetchFn !== 'function' || !Number.isFinite(providerTimeoutMs) || providerTimeoutMs <= 1) return null;
  const reserve = Math.min(1000, Math.max(1, Math.floor(providerTimeoutMs / 10)));
  const deadlineMs = Math.max(1, Math.min(30_000, Number(timeoutMs) || 15_000, providerTimeoutMs - reserve));
  return async function answer(input) {
    if (!input || typeof input !== 'object') return null;
    const payload = requestPayload(input);
    if (!payload || input.signal?.aborted) return null;
    const body = JSON.stringify(payload);
    if (encoder.encode(body).length > MAX_REQUEST_BYTES) return null;
    const controller = new AbortController();
    let timer, cancel;
    const deadline = new Promise(resolve => {
      cancel = () => { controller.abort(); resolve(null); };
      timer = setTimeout(cancel, deadlineMs);
      input.signal?.addEventListener('abort', cancel, { once: true });
    });
    const operation = (async () => {
      try {
        const response = await fetchFn(target.url, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body,
        });
        const result = await responseJSON(response, controller.signal);
        return controller.signal.aborted ? null : answerPayload(result, payload.knowledge);
      } catch { return null; }
    })();
    try { return await Promise.race([operation, deadline]); }
    finally { clearTimeout(timer); input.signal?.removeEventListener('abort', cancel); }
  };
}
