import { CONSENT_VERSION, UUID, MerchantError, digest, field, principalHash, requirePrincipal } from './merchant-common.mjs';
import { publicMerchant } from './merchant-binding.mjs';

const READ = 'merchant:support:read';
const WRITE = 'merchant:support:write';
const LEASE_MS = 120000;
const SESSION_MS = 30 * 86400000;

/**
 * Private ChatGPT conversations are bound to an authenticated issuer+subject and
 * one server-owned merchant. A durable operation receipt prevents blind retries.
 * Chatwoot does not promise message idempotency, so ambiguous writes require review.
 */
export function createMerchantSupportService({ db, merchant, chatwoot, knowledge, now = Date.now }) {
  if (!db?.prepare || !merchant?.merchantId || !merchant?.siteSlug) throw new Error('Merchant service requires a bound D1 database.');
  const scope = [merchant.siteSlug, merchant.merchantId];
  // Numeric Chatwoot display/contact IDs can collide after a merchant reconnects
  // to a different instance or account. Persist the original configuration identity.
  const bindingDigest = digest(JSON.stringify({ siteSlug: merchant.siteSlug, merchantId: merchant.merchantId,
    origin: merchant.origin, authorizationRef: merchant.authorizationRef, chatwoot: merchant.chatwoot }));
  const one = (sql, ...args) => db.prepare(sql).bind(...scope, ...args).first();
  const all = async (sql, ...args) => (await db.prepare(sql).bind(...scope, ...args).all()).results ?? [];
  const run = (sql, ...args) => db.prepare(sql).bind(...scope, ...args).run();

  function requireMerchant(id) {
    if (id !== merchant.merchantId) throw new MerchantError(404, 'MERCHANT_NOT_FOUND', 'Choose the merchant connected to this service.');
  }
  function connected() {
    if (!chatwoot || !merchant.chatwoot) throw new MerchantError(503, 'SUPPORT_NOT_CONNECTED', 'The merchant has not connected customer support.');
  }
  async function identity(principal, permission) {
    requirePrincipal(principal, permission);
    return principalHash(principal);
  }
  async function rate(principal, action, limit = 30) {
    const window = Math.floor(now() / 60000);
    const row = await one(`INSERT INTO merchant_support_limits (site_slug, merchant_id, principal_hash, action, window, count)
      VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT (site_slug, merchant_id, principal_hash, action, window)
      DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`, principal, action, window, limit);
    if (!row) throw new MerchantError(429, 'RATE_LIMITED', 'Please wait before trying customer support again.');
    await run('DELETE FROM merchant_support_limits WHERE site_slug = ? AND merchant_id = ? AND window < ?', window - 60);
  }
  // Keep parameter order explicit on UPDATEs; tenant scope is always part of WHERE.
  async function expireLeases() {
    await db.prepare(`UPDATE merchant_support_operations SET state = 'uncertain', lease_token = NULL, updated_at = ?
      WHERE site_slug = ? AND merchant_id = ? AND state = 'running' AND lease_until <= ?`).bind(now(), ...scope, now()).run();
    await db.prepare(`UPDATE merchant_support_threads SET state = 'uncertain', updated_at = ?
      WHERE site_slug = ? AND merchant_id = ? AND state = 'creating' AND EXISTS
      (SELECT 1 FROM merchant_support_operations o WHERE o.site_slug = merchant_support_threads.site_slug
      AND o.merchant_id = merchant_support_threads.merchant_id AND o.thread_id = merchant_support_threads.id
      AND o.kind = 'start' AND o.state = 'uncertain')`).bind(now(), ...scope).run();
  }
  function receipt(row) {
    let result = {};
    if (row.result_json) { try { result = JSON.parse(row.result_json); } catch { /* no untrusted body in error */ } }
    return { ...result, conversationId: row.thread_id, operationId: row.id,
      status: row.state === 'running' ? 'pending' : row.state,
      delivered: row.state === 'delivered', destination: 'merchant-chatwoot-inbox',
      ...(row.state === 'uncertain' ? { needsReconciliation: true, message: 'Delivery could not be confirmed. Do not resend with a new key; the merchant must review this operation.' } : {}) };
  }
  async function thread(id, principal) {
    if (!UUID.test(id ?? '')) throw new MerchantError(404, 'CONVERSATION_NOT_FOUND', 'This conversation was not found.');
    const row = await one(`SELECT * FROM merchant_support_threads WHERE site_slug = ? AND merchant_id = ?
      AND id = ? AND principal_hash = ? AND binding_hash = ? AND expires_at > ?`, id, principal, await bindingDigest, now());
    if (!row) throw new MerchantError(404, 'CONVERSATION_NOT_FOUND', 'This conversation was not found or has expired.');
    return row;
  }
  async function remoteThread(row) {
    if (row.state !== 'active' || !row.conversation_id || !row.contact_id) {
      throw new MerchantError(409, 'CONVERSATION_NOT_READY', 'Wait for the conversation receipt or ask the merchant to review delivery.');
    }
    const remote = await chatwoot.getConversation({ conversationId: row.conversation_id, contactId: row.contact_id });
    if (remote.id !== row.conversation_id || remote.accountId !== merchant.chatwoot.accountId ||
        remote.inboxId !== merchant.chatwoot.apiInboxId || remote.contactId !== row.contact_id) {
      throw new MerchantError(403, 'CONVERSATION_BINDING_MISMATCH', 'This conversation cannot be accessed.');
    }
    return remote;
  }
  async function operation({ principal, idempotencyKey, kind, conversationId, payload }, execute) {
    if (!UUID.test(idempotencyKey ?? '')) throw new MerchantError(400, 'INVALID_IDEMPOTENCY_KEY', 'Use one stable UUID per requested action.');
    const keyHash = await digest(idempotencyKey);
    const payloadHash = await digest(JSON.stringify({ kind, conversationId: conversationId ?? null, payload }));
    const bindingHash = await bindingDigest;
    await expireLeases();
    const prior = () => one(`SELECT * FROM merchant_support_operations WHERE site_slug = ? AND merchant_id = ? AND principal_hash = ? AND key_hash = ?`, principal, keyHash);
    const replay = row => {
      if (row.binding_hash !== bindingHash) throw new MerchantError(409, 'CONVERSATION_BINDING_MISMATCH', 'This action belongs to a previous merchant connection.');
      if (row.payload_hash !== payloadHash || row.kind !== kind) throw new MerchantError(409, 'IDEMPOTENCY_CONFLICT', 'That request key belongs to different content.');
      return receipt(row);
    };
    const existing = await prior();
    if (existing) return replay(existing);
    if (conversationId) {
      const unknown = await one(`SELECT id FROM merchant_support_operations WHERE site_slug = ? AND merchant_id = ? AND thread_id = ? AND state IN ('running','uncertain') LIMIT 1`, conversationId);
      if (unknown) throw new MerchantError(409, 'DELIVERY_REVIEW_REQUIRED', 'The previous action must finish or be reviewed before sending more messages.');
    }
    await rate(principal, 'write', 15);
    const id = crypto.randomUUID(); const threadId = conversationId ?? crypto.randomUUID(); const lease = crypto.randomUUID(); const at = now();
    let row;
    try {
      row = await one(`INSERT INTO merchant_support_operations
        (site_slug, merchant_id, id, thread_id, principal_hash, binding_hash, key_hash, kind, payload_hash, state, lease_token, lease_until, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?)
        ON CONFLICT (site_slug, merchant_id, principal_hash, key_hash) DO NOTHING RETURNING *`,
      id, threadId, principal, bindingHash, keyHash, kind, payloadHash, lease, at + LEASE_MS, at, at);
    } catch {
      const raced = await prior(); if (raced) return replay(raced);
      throw new MerchantError(409, 'CONVERSATION_BUSY', 'Another action is already being processed for this conversation.');
    }
    if (!row) { const raced = await prior(); if (raced) return replay(raced); throw new MerchantError(503, 'RECEIPT_UNAVAILABLE', 'The request receipt is unavailable.'); }
    let externalStarted = false;
    const assertLease = async () => {
      const valid = await one(`SELECT id FROM merchant_support_operations WHERE site_slug = ? AND merchant_id = ?
        AND id = ? AND state = 'running' AND lease_token = ? AND lease_until > ?`, id, lease, now());
      if (!valid) throw new MerchantError(409, 'DELIVERY_REVIEW_REQUIRED', 'The operation lease expired; review delivery before continuing.');
    };
    try {
      const result = await execute({ id, threadId, principal, assertLease, markExternal: async () => { await assertLease(); externalStarted = true; } });
      const completed = await db.prepare(`UPDATE merchant_support_operations SET state = 'delivered', result_json = ?, lease_token = NULL, updated_at = ?
        WHERE site_slug = ? AND merchant_id = ? AND id = ? AND state = 'running' AND lease_token = ? AND lease_until > ? RETURNING *`)
        .bind(JSON.stringify(result), now(), ...scope, id, lease, now()).first();
      if (!completed) { await expireLeases(); return receipt({ ...row, state: 'uncertain' }); }
      return receipt(completed);
    } catch (error) {
      const ambiguous = externalStarted && (error?.ambiguous !== false);
      const state = ambiguous ? 'uncertain' : 'failed';
      const result = { error: { code: ambiguous ? 'DELIVERY_UNCONFIRMED' : 'SUPPORT_ACTION_FAILED',
        message: ambiguous ? 'The merchant must review this delivery before it is retried.' : 'Customer support could not complete the action.' } };
      const completed = await db.prepare(`UPDATE merchant_support_operations SET state = ?, result_json = ?, lease_token = NULL, updated_at = ?
        WHERE site_slug = ? AND merchant_id = ? AND id = ? AND state = 'running' AND lease_token = ? RETURNING *`)
        .bind(state, JSON.stringify(result), now(), ...scope, id, lease).first();
      if (kind === 'start') await db.prepare(`UPDATE merchant_support_threads SET state = ?, updated_at = ? WHERE site_slug = ? AND merchant_id = ? AND id = ? AND state = 'creating'`)
        .bind(state, now(), ...scope, threadId).run();
      return receipt(completed ?? { ...row, state: 'uncertain' });
    }
  }

  return {
    async searchKnowledge({ merchantId, query }) {
      requireMerchant(merchantId);
      if (!knowledge) throw new MerchantError(503, 'KNOWLEDGE_UNAVAILABLE', 'Approved merchant information is not connected.');
      const result = await knowledge.search(field(query, 'query', 500), { limit: 8, now: now() });
      return { merchant: publicMerchant(merchant), result };
    },
    async startConversation({ principal, merchantId, message, idempotencyKey, consent }) {
      requireMerchant(merchantId); connected();
      const who = await identity(principal, WRITE);
      const content = field(message, 'message', 4000);
      if (consent?.accepted !== true || consent.version !== CONSENT_VERSION) throw new MerchantError(400, 'CONSENT_REQUIRED', 'Confirm sharing this message with the merchant and its support service.');
      return operation({ principal: who, idempotencyKey, kind: 'start', payload: { content, consent: CONSENT_VERSION } }, async ({ id, threadId, markExternal, assertLease }) => {
        await db.prepare(`INSERT INTO merchant_support_threads
          (site_slug, merchant_id, id, principal_hash, binding_hash, state, consent_version, consent_at, created_at, updated_at, expires_at)
          VALUES (?, ?, ?, ?, ?, 'creating', ?, ?, ?, ?, ?)`)
          .bind(...scope, threadId, who, await bindingDigest, CONSENT_VERSION, now(), now(), now(), now() + SESSION_MS).run();
        await markExternal();
        // An opaque per-thread identity avoids unapproved merging across channels or accounts.
        const contact = await chatwoot.createContact({ identifier: `bs_${await digest(JSON.stringify([...scope, who, threadId]))}`, name: 'ChatGPT customer' });
        if (!Number.isSafeInteger(contact.id) || contact.id <= 0 || typeof contact.sourceId !== 'string' || !contact.sourceId) throw Error('Invalid contact acknowledgement.');
        await assertLease();
        await db.prepare(`UPDATE merchant_support_threads SET contact_id = ?, contact_source_id = ?, updated_at = ? WHERE site_slug = ? AND merchant_id = ? AND id = ?`)
          .bind(contact.id, contact.sourceId, now(), ...scope, threadId).run();
        await markExternal();
        const remote = await chatwoot.createConversation({ contactId: contact.id, sourceId: contact.sourceId, message: content });
        if (!Number.isSafeInteger(remote.id) || remote.id <= 0 || remote.accountId !== merchant.chatwoot.accountId || remote.inboxId !== merchant.chatwoot.apiInboxId || remote.contactId !== contact.id) throw Error('Invalid conversation acknowledgement.');
        await assertLease();
        await db.prepare(`UPDATE merchant_support_threads SET conversation_id = ?, state = 'active', updated_at = ? WHERE site_slug = ? AND merchant_id = ? AND id = ?`)
          .bind(remote.id, now(), ...scope, threadId).run();
        return { merchant: publicMerchant(merchant), supportStatus: remote.status, message: 'Your message is stored in the merchant support inbox. A reply may arrive later.', providerReceipt: String(remote.id), requestId: id };
      });
    },
    async sendMessage({ principal, merchantId = merchant.merchantId, conversationId, message, idempotencyKey }) {
      requireMerchant(merchantId); connected(); const who = await identity(principal, WRITE); const content = field(message, 'message', 4000);
      const row = await thread(conversationId, who);
      return operation({ principal: who, idempotencyKey, kind: 'message', conversationId, payload: { content } }, async ({ id, markExternal }) => {
        await remoteThread(row);
        await markExternal();
        const sent = await chatwoot.sendIncoming({ conversationId: row.conversation_id, content, sourceId: `buyersite_${id}`, contactId: row.contact_id });
        if (!Number.isSafeInteger(sent.id) || sent.id <= 0) throw Error('Invalid message acknowledgement.');
        return { messageId: String(sent.id), message: 'The merchant support inbox accepted this message.' };
      });
    },
    async getUpdates({ principal, merchantId = merchant.merchantId, conversationId, cursor = '0' }) {
      requireMerchant(merchantId); connected(); const who = await identity(principal, READ);
      if (typeof cursor !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(cursor) || !Number.isSafeInteger(Number(cursor))) throw new MerchantError(400, 'INVALID_CURSOR', 'Use the message cursor returned by this conversation.');
      await expireLeases();
      const row = await thread(conversationId, who); await rate(who, 'read', 60);
      const delivery = (await all(`SELECT * FROM merchant_support_operations WHERE site_slug = ? AND merchant_id = ?
        AND thread_id = ? AND principal_hash = ? ORDER BY created_at DESC, id DESC LIMIT 20`, conversationId, who)).map(receipt);
      if (row.state !== 'active') return { conversationId, status: row.state === 'creating' ? 'pending' : row.state, delivery, messages: [], nextCursor: cursor };
      const remote = await remoteThread(row);
      const page = await chatwoot.listPublicMessages({ conversationId: row.conversation_id, after: Number(cursor), contactId: row.contact_id });
      const candidates = (page.messages ?? []).filter(item => item.private === false && Number.isSafeInteger(item.id) && item.id > Number(cursor) &&
        ['incoming', 'outgoing', 0, 1].includes(item.message_type ?? item.direction)).sort((a, b) => a.id - b.id);
      const messages = []; let bytes = 0; let truncated = false;
      for (const item of candidates) {
        const timestamp = item.createdAt ?? item.created_at;
        const projected = { id: String(item.id), content: typeof item.content === 'string' ? item.content.slice(0, 6000) : '',
          direction: item.message_type === 0 || item.message_type === 'incoming' || item.direction === 'incoming' ? 'customer' : 'merchant',
          createdAt: typeof timestamp === 'string' || typeof timestamp === 'number' ? timestamp : null };
        const size = JSON.stringify(projected).length;
        if (bytes + size > 50000) { truncated = true; break; }
        messages.push(projected); bytes += size;
      }
      const next = Number(page.nextCursor);
      return { conversationId, status: remote.status, delivery, humanRequested: row.handoff_requested === 1, messages,
        nextCursor: truncated ? messages.at(-1)?.id ?? cursor : Number.isSafeInteger(next) && next >= Number(cursor) ? String(next) : cursor,
        hasMore: truncated };
    },
    async requestHuman({ principal, merchantId = merchant.merchantId, conversationId, idempotencyKey }) {
      requireMerchant(merchantId); connected(); const who = await identity(principal, WRITE); const row = await thread(conversationId, who);
      if (!UUID.test(idempotencyKey ?? '')) throw new MerchantError(400, 'INVALID_IDEMPOTENCY_KEY', 'Use one stable UUID per requested action.');
      // Human intent must stop automation even while an earlier outbound write is
      // uncertain. A delayed remote handoff never gives the bot permission to resume.
      await db.prepare(`UPDATE merchant_support_threads SET handoff_requested = 1, updated_at = ? WHERE site_slug = ? AND merchant_id = ? AND id = ?`)
        .bind(now(), ...scope, conversationId).run();
      return operation({ principal: who, idempotencyKey, kind: 'human', conversationId, payload: {} }, async ({ markExternal }) => {
        await remoteThread(row);
        await db.prepare(`UPDATE merchant_support_threads SET handoff_requested = 1, updated_at = ? WHERE site_slug = ? AND merchant_id = ? AND id = ?`)
          .bind(now(), ...scope, conversationId).run();
        await markExternal();
        const result = await chatwoot.requestHuman({ conversationId: row.conversation_id });
        if (result.status !== 'open') throw Error('Human handoff was not acknowledged.');
        return { supportStatus: 'open', humanRequested: true, message: 'The conversation is in the human support queue. A person has not necessarily joined yet.' };
      });
    },
    async canAutomate(conversationId) {
      const row = await one(`SELECT handoff_requested FROM merchant_support_threads WHERE site_slug = ? AND merchant_id = ? AND binding_hash = ? AND conversation_id = ?`, await bindingDigest, conversationId);
      return !row || row.handoff_requested !== 1;
    },
    async operationStatus({ principal, operationId }) {
      const who = await identity(principal, READ);
      if (!UUID.test(operationId ?? '')) throw new MerchantError(404, 'OPERATION_NOT_FOUND', 'The operation was not found.');
      await expireLeases();
      const row = await one(`SELECT * FROM merchant_support_operations WHERE site_slug = ? AND merchant_id = ? AND principal_hash = ? AND binding_hash = ? AND id = ?`, who, await bindingDigest, operationId);
      if (!row) throw new MerchantError(404, 'OPERATION_NOT_FOUND', 'The operation was not found.');
      return receipt(row);
    },
    async diagnostics() {
      await expireLeases();
      const groups = await all(`SELECT state, COUNT(*) AS count FROM merchant_support_operations WHERE site_slug = ? AND merchant_id = ? GROUP BY state`);
      const review = await all(`SELECT id, thread_id AS conversationId, kind, state, created_at AS createdAt, updated_at AS updatedAt FROM merchant_support_operations
        WHERE site_slug = ? AND merchant_id = ? AND state = 'uncertain' ORDER BY created_at LIMIT 50`);
      return { operations: groups, reviewRequired: review };
    },
  };
}
