import { MerchantError } from './merchant-common.mjs';
import { validateMerchantChatwootBinding } from './merchant-chatwoot.mjs';

const DAY_MS = 86_400_000;
const FINISHED = "status IN ('delivered','handed_off','ignored','unknown','dead')";
const SCOPE = 'site_slug = ? AND merchant_id = ? AND chatwoot_origin = ? AND account_id = ? AND inbox_id IN (?, ?)';

/**
 * Redact retained message bodies without removing delivery or deduplication
 * tombstones. Unknown/dead jobs must continue blocking their conversations.
 * This affects the local queue only; upstream retention is managed separately.
 */
export async function pruneMerchantQueue(db, merchant, { now = Date.now(), retentionDays = 30 } = {}) {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 || retentionDays > 365) {
    throw new MerchantError(400, 'INVALID_QUEUE_RETENTION', 'Queue retention must be an integer from 1 to 365 days.');
  }
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) {
    throw new MerchantError(400, 'INVALID_QUEUE_CLOCK', 'Queue maintenance requires a valid millisecond timestamp.');
  }
  const binding = validateMerchantChatwootBinding(merchant);
  if (!binding.websiteInboxId || !binding.apiInboxId) {
    throw new MerchantError(400, 'INCOMPLETE_QUEUE_BINDING', 'Both merchant support inboxes must be configured.');
  }
  if (typeof db?.prepare !== 'function') {
    throw new MerchantError(503, 'QUEUE_STORE_UNAVAILABLE', 'The merchant queue is unavailable.');
  }
  const scope = [merchant.siteSlug, binding.merchantId, binding.baseUrl, binding.accountId, binding.websiteInboxId, binding.apiInboxId];
  const cutoff = now - retentionDays * DAY_MS;
  // A single statement selects and redacts at most 500 eligible records. The
  // repeated scope and eligibility predicates keep every update fail-closed.
  // Do not update timestamps or leases: they are reconciliation evidence.
  const result = await db.prepare(`UPDATE merchant_agentbot_jobs SET payload_json = '{}', answer_json = NULL
    WHERE ${SCOPE} AND ${FINISHED} AND updated_at <= ? AND (payload_json <> '{}' OR answer_json IS NOT NULL)
      AND id IN (SELECT id FROM merchant_agentbot_jobs
        WHERE ${SCOPE} AND ${FINISHED} AND updated_at <= ? AND (payload_json <> '{}' OR answer_json IS NOT NULL)
        ORDER BY updated_at, id LIMIT 500)`)
    .bind(...scope, cutoff, ...scope, cutoff).run();
  const redacted = result?.meta?.changes;
  if (!Number.isSafeInteger(redacted) || redacted < 0 || redacted > 500) {
    throw new MerchantError(503, 'QUEUE_MAINTENANCE_UNCONFIRMED', 'The queue maintenance result could not be confirmed.');
  }
  return redacted;
}
