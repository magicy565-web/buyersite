// Server-only Chatwoot adapter. All account/inbox coordinates come from the merchant binding.
// Chatwoot source_id is a correlation field, not an exactly-once delivery guarantee.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export class ChatwootClientError extends Error {
  constructor(code, { status = null, ambiguous = false } = {}) {
    super(code);
    this.name = 'ChatwootClientError';
    this.code = code;
    this.status = status;
    this.ambiguous = ambiguous;
  }
}

function positiveId(value, label = 'INVALID_ID') {
  const id = typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id < 1) throw new ChatwootClientError(label);
  return id;
}

function boundedText(value, max, code) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) throw new ChatwootClientError(code);
  return value.trim();
}

export function validateMerchantChatwootBinding(merchant) {
  if (!merchant || typeof merchant !== 'object') throw new ChatwootClientError('MERCHANT_NOT_CONFIGURED');
  boundedText(merchant.merchantId, 160, 'MERCHANT_NOT_CONFIGURED');
  boundedText(merchant.authorizationRef, 240, 'MERCHANT_NOT_AUTHORIZED');
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(merchant.siteSlug ?? '')) throw new ChatwootClientError('INVALID_SITE_SLUG');
  let base;
  try { base = new URL(merchant.chatwoot?.baseUrl); } catch { throw new ChatwootClientError('INVALID_CHATWOOT_ORIGIN'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new ChatwootClientError('INVALID_CHATWOOT_ORIGIN');
  const accountId = positiveId(merchant.chatwoot.accountId, 'INVALID_ACCOUNT_ID');
  const apiInboxId = merchant.chatwoot.apiInboxId == null ? null : positiveId(merchant.chatwoot.apiInboxId, 'INVALID_API_INBOX_ID');
  const websiteInboxId = merchant.chatwoot.websiteInboxId == null ? null : positiveId(merchant.chatwoot.websiteInboxId, 'INVALID_WEBSITE_INBOX_ID');
  if ((!apiInboxId && !websiteInboxId) || (apiInboxId && apiInboxId === websiteInboxId)) throw new ChatwootClientError('INVALID_INBOX_BINDING');
  return { merchantId: merchant.merchantId, accountId, apiInboxId, websiteInboxId, baseUrl: base.origin };
}

function token(value, code) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) throw new ChatwootClientError(code);
  return value;
}

function publicMessage(message) {
  const kind = message?.message_type;
  if (message?.private !== false || !['incoming', 'outgoing', 0, 1].includes(kind)) return null;
  const id = positiveId(message.id, 'INVALID_CHATWOOT_RESPONSE');
  const direction = kind === 0 || kind === 'incoming' ? 'incoming' : 'outgoing';
  const timestamp = typeof message.created_at === 'number' ? message.created_at * 1000 : Date.parse(message.created_at);
  return {
    id,
    content: typeof message.content === 'string' ? message.content : '',
    message_type: direction,
    direction,
    private: false,
    created_at: message.created_at ?? null,
    createdAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    sender: { type: typeof message.sender?.type === 'string' ? message.sender.type : (kind === 0 || kind === 'incoming' ? 'contact' : 'agent') },
  };
}

export function createMerchantChatwootClient({ merchant, apiToken, agentBotToken, fetchFn = fetch, timeoutMs = 10_000 }) {
  const binding = validateMerchantChatwootBinding(merchant);
  const allowedInboxes = [binding.apiInboxId, binding.websiteInboxId].filter(Boolean);
  const base = `${binding.baseUrl}/api/v1/accounts/${binding.accountId}`;
  const timeout = Math.max(100, Math.min(30_000, Number(timeoutMs) || 10_000));

  async function request(path, { method = 'GET', body, asAgent = false } = {}) {
    const credential = token(asAgent ? agentBotToken : apiToken, asAgent ? 'AGENTBOT_TOKEN_NOT_CONFIGURED' : 'CHATWOOT_API_TOKEN_NOT_CONFIGURED');
    const write = method !== 'GET';
    let response;
    try {
      response = await fetchFn(base + path, {
        method, redirect: 'error', signal: AbortSignal.timeout(timeout),
        headers: { Authorization: `Bearer ${credential}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new ChatwootClientError('CHATWOOT_TRANSPORT_ERROR', { ambiguous: write }); }
    if (!response.ok) throw new ChatwootClientError('CHATWOOT_HTTP_ERROR', { status: response.status, ambiguous: write && (response.status >= 500 || [408, 425, 429].includes(response.status)) });
    try { return await response.json(); } catch { throw new ChatwootClientError('INVALID_CHATWOOT_RESPONSE', { status: response.status, ambiguous: write }); }
  }

  function conversationData(raw, { conversationId, contactId, inboxId } = {}) {
    if (!raw || positiveId(raw.id, 'INVALID_CHATWOOT_RESPONSE') !== (conversationId ?? raw.id) ||
        raw.account_id !== binding.accountId || !allowedInboxes.includes(raw.inbox_id) ||
        (inboxId != null && raw.inbox_id !== inboxId)) throw new ChatwootClientError('CHATWOOT_BINDING_MISMATCH');
    const senderId = positiveId(raw.meta?.sender?.id, 'INVALID_CHATWOOT_CONTACT');
    if (contactId != null && senderId !== positiveId(contactId)) throw new ChatwootClientError('CHATWOOT_CONTACT_MISMATCH');
    if (!['pending', 'open', 'resolved', 'snoozed'].includes(raw.status)) throw new ChatwootClientError('INVALID_CHATWOOT_STATUS');
    const latest = [...(Array.isArray(raw.messages) ? raw.messages : []), ...(raw.last_non_activity_message ? [raw.last_non_activity_message] : [])];
    const messages = [...new Map(latest.map(publicMessage).filter(Boolean).map(message => [message.id, message])).values()];
    return {
      id: raw.id, accountId: raw.account_id, inboxId: raw.inbox_id, contactId: senderId, status: raw.status,
      // Snake-case aliases make validation at integration boundaries unambiguous.
      account_id: raw.account_id, inbox_id: raw.inbox_id, contact_id: senderId,
      assigneeType: raw.meta?.assignee_type ?? null,
      assigneeId: raw.meta?.assignee?.id ?? null,
      meta: { sender: { id: senderId }, assignee_type: raw.meta?.assignee_type ?? null, assignee: raw.meta?.assignee?.id ? { id: raw.meta.assignee.id } : null },
      messages,
    };
  }

  async function getConversation({ conversationId, contactId, asAgent = false }) {
    const id = positiveId(conversationId);
    return conversationData(await request(`/conversations/${id}`, { asAgent }), { conversationId: id, contactId });
  }

  async function createContact({ identifier, name, email }) {
    if (!binding.apiInboxId) throw new ChatwootClientError('API_INBOX_NOT_CONFIGURED');
    const body = { inbox_id: binding.apiInboxId, identifier: boundedText(identifier, 200, 'INVALID_CONTACT_IDENTIFIER') };
    if (name != null) body.name = boundedText(name, 120, 'INVALID_CONTACT_NAME');
    if (email != null) {
      body.email = boundedText(email, 254, 'INVALID_CONTACT_EMAIL');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) throw new ChatwootClientError('INVALID_CONTACT_EMAIL');
    }
    const raw = await request('/contacts', { method: 'POST', body });
    try {
      const contact = raw.payload?.contact;
      const id = positiveId(contact?.id, 'INVALID_CHATWOOT_RESPONSE');
      const direct = raw.payload?.contact_inbox;
      const association = direct?.inbox?.id === binding.apiInboxId ? direct : contact?.contact_inboxes?.find(item => item.inbox?.id === binding.apiInboxId);
      const sourceId = boundedText(association?.source_id, 512, 'INVALID_CHATWOOT_RESPONSE');
      if (contact.identifier != null && contact.identifier !== body.identifier) throw new ChatwootClientError('CHATWOOT_CONTACT_MISMATCH');
      return { id, sourceId };
    } catch (error) { error.ambiguous = true; throw error; }
  }

  async function createConversation({ contactId, sourceId, message }) {
    if (!binding.apiInboxId) throw new ChatwootClientError('API_INBOX_NOT_CONFIGURED');
    const body = { inbox_id: binding.apiInboxId, contact_id: positiveId(contactId), source_id: boundedText(sourceId, 512, 'INVALID_CONTACT_SOURCE'), status: 'pending' };
    if (message != null) body.message = { content: boundedText(typeof message === 'string' ? message : message.content, 6000, 'INVALID_MESSAGE'), message_type: 'incoming', private: false, content_type: 'text' };
    const raw = await request('/conversations', { method: 'POST', body });
    try { return conversationData(raw, { contactId: body.contact_id, inboxId: binding.apiInboxId }); }
    catch (error) { error.ambiguous = true; throw error; }
  }

  function messageData(raw, conversation, kind) {
    try {
      const message = publicMessage(raw);
      if (!message || message.message_type !== kind || (raw.inbox_id != null && raw.inbox_id !== conversation.inboxId) ||
          (raw.conversation_id != null && raw.conversation_id !== conversation.id)) throw new ChatwootClientError('INVALID_CHATWOOT_RESPONSE');
      return message;
    } catch (error) { error.ambiguous = true; throw error; }
  }

  async function sendIncoming({ conversationId, content, sourceId, contactId }) {
    const body = { content: boundedText(content, 6000, 'INVALID_MESSAGE'), message_type: 'incoming', private: false, content_type: 'text' };
    if (sourceId != null) body.source_id = boundedText(sourceId, 200, 'INVALID_SOURCE_ID');
    const conversation = await getConversation({ conversationId, contactId });
    if (conversation.inboxId !== binding.apiInboxId) throw new ChatwootClientError('INCOMING_REQUIRES_API_INBOX');
    return messageData(await request(`/conversations/${conversation.id}/messages`, { method: 'POST', body }), conversation, 'incoming');
  }

  async function listPublicMessages({ conversationId, after, before, contactId }) {
    const conversation = await getConversation({ conversationId, contactId });
    const params = new URLSearchParams({ filter_internal_messages: 'true' });
    if (after != null) {
      if (!(after === 0 || after === '0')) positiveId(after);
      params.set('after', String(after));
    }
    if (before != null) params.set('before', String(positiveId(before)));
    const raw = await request(`/conversations/${conversation.id}/messages?${params}`);
    if (!Array.isArray(raw.payload)) throw new ChatwootClientError('INVALID_CHATWOOT_RESPONSE');
    let nextCursor = after == null ? null : Number(after);
    const messages = [];
    for (const item of raw.payload) {
      const id = positiveId(item.id, 'INVALID_CHATWOOT_RESPONSE');
      if ((item.account_id != null && item.account_id !== binding.accountId) ||
          (item.inbox_id != null && item.inbox_id !== conversation.inboxId) ||
          (item.conversation_id != null && item.conversation_id !== conversation.id)) throw new ChatwootClientError('CHATWOOT_BINDING_MISMATCH');
      nextCursor = Math.max(nextCursor ?? 0, id);
      const message = publicMessage(item);
      if (message) messages.push(message);
    }
    messages.sort((a, b) => a.id - b.id);
    return { messages, nextCursor };
  }

  async function sendAgentReply({ conversationId, content, inReplyTo, sourceId, expectedAgentBotId, beforeSend }) {
    token(agentBotToken, 'AGENTBOT_TOKEN_NOT_CONFIGURED');
    const replyId = positiveId(inReplyTo);
    const body = { content: boundedText(content, 6000, 'INVALID_MESSAGE'), message_type: 'outgoing', private: false, content_type: 'text', content_attributes: { in_reply_to: replyId } };
    if (sourceId != null) body.source_id = boundedText(sourceId, 200, 'INVALID_SOURCE_ID');
    // This preflight is best effort: Chatwoot has no conditional message-create API.
    const conversation = await getConversation({ conversationId, asAgent: true });
    if (conversation.status !== 'pending' || (conversation.assigneeType && conversation.assigneeType !== 'AgentBot')) throw new ChatwootClientError('HUMAN_HAS_CONTROL');
    if (conversation.assigneeType === 'AgentBot' && (expectedAgentBotId == null || conversation.assigneeId !== positiveId(expectedAgentBotId))) throw new ChatwootClientError('AGENTBOT_ASSIGNMENT_CHANGED');
    if (conversation.messages.some(item => item.message_type === 'incoming' && item.id > replyId)) throw new ChatwootClientError('MESSAGE_SUPERSEDED');
    if (typeof beforeSend === 'function') {
      let permitted = false;
      try { permitted = await beforeSend(); } catch { /* Control storage failure is fail-closed. */ }
      if (permitted !== true) throw new ChatwootClientError('HUMAN_HAS_CONTROL');
    }
    return messageData(await request(`/conversations/${conversation.id}/messages`, { method: 'POST', body, asAgent: true }), conversation, 'outgoing');
  }

  async function requestHuman({ conversationId, contactId }) {
    const asAgent = Boolean(agentBotToken);
    const conversation = await getConversation({ conversationId, contactId, asAgent });
    if (conversation.status !== 'pending') return { status: conversation.status, handedOff: false };
    const raw = await request(`/conversations/${conversation.id}/toggle_status`, { method: 'POST', asAgent, body: { status: 'open' } });
    // Current Chatwoot's AgentBot handoff branch leaves payload.success null.
    if (raw.payload?.current_status !== 'open' || raw.payload.conversation_id !== conversation.id) throw new ChatwootClientError('INVALID_CHATWOOT_RESPONSE', { ambiguous: true });
    return { status: 'open', handedOff: true };
  }

  return Object.freeze({ createContact, createConversation, sendIncoming, getConversation, listPublicMessages, sendAgentReply, requestHuman });
}
