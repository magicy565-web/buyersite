import { CONSENT_VERSION, UUID, MerchantError, digest, field } from './merchant-common.mjs';

const INPUT_FIELDS = new Set(['operationId', 'expectedUpdatedAt', 'resolution', 'externalConversationId', 'externalMessageId', 'evidenceRef', 'evidenceHash']);
const OPAQUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const HASH = /^[0-9a-f]{64}$/;
const invalid = () => new MerchantError(400, 'INVALID_RECONCILIATION', 'Provide an operation, its current update time, a resolution, and an opaque evidence reference with its SHA-256 hash.');
const mismatch = () => new MerchantError(409, 'RECONCILIATION_EVIDENCE_UNVERIFIED', 'The provider evidence does not verify this operation. No recovery was applied.');
const stale = () => new MerchantError(409, 'RECONCILIATION_STALE', 'The operation or its conversation changed. Review its current receipt before reconciling.');
const positive = value => Number.isSafeInteger(value) && value > 0;

function externalId(value) {
  if (value === undefined) return null;
  const id = typeof value === 'string' && /^[1-9][0-9]{0,15}$/.test(value) ? Number(value) : value;
  if (!positive(id)) throw invalid();
  return id;
}

function validate(input, actorId) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !INPUT_FIELDS.has(key)) ||
      !UUID.test(input.operationId ?? '') || !Number.isSafeInteger(input.expectedUpdatedAt) || input.expectedUpdatedAt < 0 ||
      !['delivered', 'not_delivered'].includes(input.resolution) || typeof input.evidenceRef !== 'string' || !OPAQUE_REF.test(input.evidenceRef) || input.evidenceRef.includes('://') ||
      typeof input.evidenceHash !== 'string' || !HASH.test(input.evidenceHash) || typeof actorId !== 'string' || !actorId.trim() || actorId.length > 160 || /[\u0000-\u001f\u007f]/.test(actorId)) throw invalid();
  const conversationId = externalId(input.externalConversationId);
  const messageId = externalId(input.externalMessageId);
  // An absence assertion has no provider delivery receipt. Do not attach an
  // unverified external ID that could later be mistaken for positive evidence.
  if (input.resolution === 'not_delivered' && (conversationId !== null || messageId !== null)) throw invalid();
  return { ...input, actorId: actorId.trim(), conversationId, messageId };
}

function messageTime(message) {
  if (typeof message.createdAt === 'string') return Date.parse(message.createdAt);
  if (typeof message.created_at === 'number' && Number.isFinite(message.created_at)) return message.created_at * 1000;
  if (typeof message.created_at === 'string') return Date.parse(message.created_at);
  return NaN;
}

/**
 * Owner-authorized recovery of uncertain support writes. The caller must enforce
 * owner authentication and derive actorId from server configuration. This module
 * only reads Chatwoot; it never creates a contact, sends a message, or resumes a bot.
 */
export function createMerchantReconciliation({ db, merchant, chatwoot, now = Date.now } = {}) {
  if (!db?.prepare || !db?.batch || !merchant?.merchantId || !merchant?.siteSlug || typeof now !== 'function') throw new Error('Merchant reconciliation requires a bound D1 database.');
  const scope = [merchant.siteSlug, merchant.merchantId];
  // Keep exactly the same field order and coordinates as the support service.
  const bindingDigest = digest(JSON.stringify({ siteSlug: merchant.siteSlug, merchantId: merchant.merchantId,
    origin: merchant.origin, authorizationRef: merchant.authorizationRef, chatwoot: merchant.chatwoot }));

  return async function reconcile(input, { actorId } = {}) {
    const details = validate(input, actorId);
    const bindingHash = await bindingDigest;
    const operation = await db.prepare(`SELECT * FROM merchant_support_operations
      WHERE site_slug = ? AND merchant_id = ? AND binding_hash = ? AND id = ?`)
      .bind(...scope, bindingHash, details.operationId).first();
    if (!operation) throw new MerchantError(404, 'OPERATION_NOT_FOUND', 'This operation is unavailable on the current merchant connection.');
    if (operation.state !== 'uncertain' || operation.updated_at !== details.expectedUpdatedAt) throw stale();
    const thread = await db.prepare(`SELECT * FROM merchant_support_threads
      WHERE site_slug = ? AND merchant_id = ? AND binding_hash = ? AND id = ? AND principal_hash = ?`)
      .bind(...scope, bindingHash, operation.thread_id, operation.principal_hash).first();
    if (!thread && (operation.kind !== 'start' || details.resolution !== 'not_delivered')) throw mismatch();
    const at = now();
    if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(operation.created_at)) throw new MerchantError(503, 'RECONCILIATION_UNAVAILABLE', 'The recovery record is unavailable.');

    let externalConversationId = null; let externalMessageId = null; let providerStatus = null;
    const verified = details.resolution === 'delivered';
    if (verified) {
      if (!chatwoot || !merchant.chatwoot || typeof chatwoot.getConversation !== 'function') throw new MerchantError(503, 'SUPPORT_NOT_CONNECTED', 'Connect the merchant provider before verifying delivery.');
      if (!positive(thread.contact_id)) throw mismatch();
      if (operation.kind === 'start') {
        externalConversationId = details.conversationId ?? thread.conversation_id;
        if (!positive(externalConversationId) || thread.conversation_id !== null && thread.conversation_id !== externalConversationId ||
            !['creating', 'uncertain', 'active'].includes(thread.state)) throw mismatch();
      } else {
        externalConversationId = thread.conversation_id;
        if (!positive(externalConversationId) || thread.state !== 'active' || details.conversationId !== null && details.conversationId !== externalConversationId) throw mismatch();
      }
      let remote;
      try { remote = await chatwoot.getConversation({ conversationId: externalConversationId, contactId: thread.contact_id }); }
      catch { throw new MerchantError(502, 'RECONCILIATION_PROVIDER_UNAVAILABLE', 'The provider could not verify this conversation. No recovery was applied.'); }
      if (!remote || remote.id !== externalConversationId || remote.accountId !== merchant.chatwoot.accountId ||
          remote.inboxId !== merchant.chatwoot.apiInboxId || remote.contactId !== thread.contact_id ||
          !['pending', 'open', 'resolved', 'snoozed'].includes(remote.status)) throw mismatch();
      providerStatus = remote.status;
      if (operation.kind === 'human') {
        if (details.messageId !== null || providerStatus !== 'open' || await digest(JSON.stringify({ kind: 'human', conversationId: operation.thread_id, payload: {} })) !== operation.payload_hash) throw mismatch();
      } else {
        if (!positive(details.messageId) || typeof chatwoot.listPublicMessages !== 'function') throw mismatch();
        externalMessageId = details.messageId;
        let page;
        try { page = await chatwoot.listPublicMessages({ conversationId: externalConversationId, after: externalMessageId - 1, contactId: thread.contact_id }); }
        catch { throw new MerchantError(502, 'RECONCILIATION_PROVIDER_UNAVAILABLE', 'The provider could not verify this message. No recovery was applied.'); }
        const candidates = Array.isArray(page?.messages) ? page.messages.filter(message => message?.id === externalMessageId) : [];
        if (candidates.length !== 1) throw mismatch();
        const message = candidates[0]; const createdAt = messageTime(message);
        if (message.private !== false || ![0, 'incoming'].includes(message.message_type ?? message.direction) ||
            !Number.isFinite(createdAt) || createdAt < operation.created_at - 30_000 || createdAt > now() + 30_000) throw mismatch();
        let content;
        try { content = field(message.content, 'provider message', 4000); } catch { throw mismatch(); }
        if (operation.kind === 'start' && thread.consent_version !== CONSENT_VERSION) throw mismatch();
        const payload = operation.kind === 'start' ? { content, consent: thread.consent_version } : { content };
        if (await digest(JSON.stringify({ kind: operation.kind, conversationId: operation.kind === 'start' ? null : operation.thread_id, payload })) !== operation.payload_hash) throw mismatch();
      }
    }

    const auditId = crypto.randomUUID();
    const updatedAt = Math.max(now(), operation.updated_at + 1);
    if (!Number.isSafeInteger(updatedAt)) throw new MerchantError(503, 'RECONCILIATION_UNAVAILABLE', 'The recovery clock is unavailable.');
    const verification = verified ? 'provider_verified' : 'owner_recorded';
    const result = {
      reconciled: true, reconciliationId: auditId, reconciliationSource: verification, reconciledAt: updatedAt,
      message: verified ? 'The provider evidence confirms that this action reached the merchant inbox.' : 'The owner recorded that this action was not delivered. No message was resent.',
      ...(verified && operation.kind === 'start' ? { providerReceipt: String(externalConversationId), messageId: String(externalMessageId), supportStatus: providerStatus } : {}),
      ...(verified && operation.kind === 'message' ? { messageId: String(externalMessageId) } : {}),
      ...(verified && operation.kind === 'human' ? { supportStatus: 'open', humanRequested: true } : {}),
    };
    // Insert the immutable audit only if both the operation CAS and the reviewed
    // thread snapshot still match. Later statements are gated by this audit ID;
    // a stale first statement cannot update an operation or activate a thread.
    const threadGuard = thread ? `EXISTS (SELECT 1 FROM merchant_support_threads t
      WHERE t.site_slug = o.site_slug AND t.merchant_id = o.merchant_id AND t.id = o.thread_id
      AND t.principal_hash = o.principal_hash AND t.binding_hash = o.binding_hash
      AND t.updated_at = ? AND t.state = ? AND t.contact_id IS ? AND t.conversation_id IS ? AND t.consent_version = ?)` :
      `NOT EXISTS (SELECT 1 FROM merchant_support_threads t WHERE t.site_slug = o.site_slug AND t.merchant_id = o.merchant_id AND t.id = o.thread_id)`;
    const threadArgs = thread ? [thread.updated_at, thread.state, thread.contact_id, thread.conversation_id, thread.consent_version] : [];
    const statements = [
      db.prepare(`INSERT INTO merchant_support_reconciliations
        (site_slug, merchant_id, id, operation_id, thread_id, binding_hash, operation_kind, previous_updated_at,
         resolution, verification, actor_id, evidence_ref, evidence_hash, external_conversation_id, external_message_id, recorded_at)
        SELECT o.site_slug, o.merchant_id, ?, o.id, o.thread_id, o.binding_hash, o.kind, o.updated_at, ?, ?, ?, ?, ?, ?, ?, ?
        FROM merchant_support_operations o WHERE o.site_slug = ? AND o.merchant_id = ? AND o.id = ?
        AND o.binding_hash = ? AND o.state = 'uncertain' AND o.updated_at = ? AND o.payload_hash = ?
        AND o.kind = ? AND o.thread_id = ? AND o.principal_hash = ? AND ${threadGuard} RETURNING id`)
        .bind(auditId, details.resolution, verification, details.actorId, details.evidenceRef, details.evidenceHash,
          externalConversationId, externalMessageId, updatedAt, ...scope, operation.id, bindingHash, details.expectedUpdatedAt,
          operation.payload_hash, operation.kind, operation.thread_id, operation.principal_hash, ...threadArgs),
      db.prepare(`UPDATE merchant_support_operations SET state = ?, result_json = ?, lease_token = NULL, updated_at = ?
        WHERE site_slug = ? AND merchant_id = ? AND id = ? AND binding_hash = ? AND state = 'uncertain' AND updated_at = ?
        AND EXISTS (SELECT 1 FROM merchant_support_reconciliations a WHERE a.site_slug = merchant_support_operations.site_slug
          AND a.merchant_id = merchant_support_operations.merchant_id AND a.operation_id = merchant_support_operations.id AND a.id = ?) RETURNING id`)
        .bind(verified ? 'delivered' : 'failed', JSON.stringify(result), updatedAt, ...scope, operation.id, bindingHash, details.expectedUpdatedAt, auditId),
    ];
    if (operation.kind === 'start' && thread) {
      statements.push(db.prepare(`UPDATE merchant_support_threads SET state = ?, conversation_id = ?, updated_at = ?
        WHERE site_slug = ? AND merchant_id = ? AND id = ? AND binding_hash = ? AND principal_hash = ?
        AND state IN (${verified ? "'creating','uncertain','active'" : "'creating','uncertain'"})
        AND EXISTS (SELECT 1 FROM merchant_support_reconciliations a WHERE a.site_slug = merchant_support_threads.site_slug
          AND a.merchant_id = merchant_support_threads.merchant_id AND a.thread_id = merchant_support_threads.id AND a.id = ?) RETURNING id`)
        .bind(verified ? 'active' : 'failed', verified ? externalConversationId : thread.conversation_id, updatedAt,
          ...scope, thread.id, bindingHash, operation.principal_hash, auditId));
    }
    let applied;
    try { applied = await db.batch(statements); }
    catch { throw new MerchantError(503, 'RECONCILIATION_STORAGE_UNAVAILABLE', 'Recovery was not confirmed. Review the operation receipt before retrying.'); }
    if (applied?.[0]?.results?.length !== 1 || applied?.[1]?.results?.length !== 1) throw stale();
    return { operationId: operation.id, conversationId: operation.thread_id, status: verified ? 'delivered' : 'failed',
      delivered: verified, resolution: details.resolution, verification, auditId, updatedAt,
      ...(externalConversationId !== null ? { externalConversationId } : {}), ...(externalMessageId !== null ? { externalMessageId } : {}) };
  };
}
