import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMerchantKnowledgeRepository } from './merchant-knowledge.mjs';
import { createMerchantOnboardingRepository, prepareBusinessHubPack } from './merchant-onboarding.mjs';
import { approvedFact, fixtureNow, merchantFixture, merchantTestDatabase } from './test-support/merchant-sqlite.mjs';

const options = { actorId: 'owner-one', now: fixtureNow, expectedRevision: 0 };
const evidence = (kind, overrides = {}) => ({ event_id: randomUUID(), kind, artifact_ref: 'redacted:proof-1', artifact_sha256: 'b'.repeat(64),
  observed_at: '2026-11-23T23:00:00.000Z', official_url: 'https://chatgpt.com/business-hub', ...overrides });

test('claim evidence remains an owner observation and cannot set official verification', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const repo = createMerchantOnboardingRepository(db, merchantFixture);
  assert.equal((await repo.get()).revision, 0);
  await assert.rejects(repo.recordEvidence({ ...evidence('claim_approved'), platform_verified: true }, options), { code: 'INVALID_CLAIM_EVIDENCE' });
  const receipt = await repo.recordEvidence(evidence('claim_approved'), options);
  assert.equal(receipt.revision, 1); assert.equal(receipt.platform_verified, false);
  assert.equal(receipt.state.reported.claim, 'approved'); assert.equal(receipt.state.status_origin, 'owner_recorded');
  assert.equal(receipt.state.native_chatwoot_bridge, false);
  assert.equal(JSON.stringify(receipt).includes('authorizationRef'), false);
});

test('receipt replay is idempotent but altered evidence cannot reuse an event ID', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const repo = createMerchantOnboardingRepository(db, merchantFixture), event = evidence('claim_approved');
  const first = await repo.recordEvidence(event, options), replay = await repo.recordEvidence(event, options);
  assert.equal(replay.replay, true); assert.equal(replay.revision, first.revision);
  assert.equal((await repo.get()).revision, 1);
  await assert.rejects(repo.recordEvidence({ ...event, artifact_sha256: 'c'.repeat(64) }, options), { code: 'CLAIM_EVIDENCE_IDEMPOTENCY_CONFLICT' });
  assert.throws(() => db.sqlite.prepare('UPDATE merchant_claim_evidence SET receipt_json = ?').run('{}'), /Immutable/);
});

test('competing evidence updates have one winner and preserve the winning receipt', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const repo = createMerchantOnboardingRepository(db, merchantFixture);
  const outcomes = await Promise.allSettled([repo.recordEvidence(evidence('claim_approved'), options), repo.recordEvidence(evidence('claim_submitted'), options)]);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(item => item.status === 'rejected').reason.code, 'CLAIM_REVISION_CONFLICT');
  assert.equal((await repo.get()).revision, 1);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS count FROM merchant_claim_evidence').get().count, 1);
});

test('claim state and evidence are isolated by both site and merchant', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const a = createMerchantOnboardingRepository(db, merchantFixture);
  await a.recordEvidence(evidence('claim_approved'), options);
  for (const changed of [{ merchantId: 'merchant-two' }, { siteSlug: 'different-edition' }]) {
    const b = createMerchantOnboardingRepository(db, { ...merchantFixture, ...changed });
    assert.equal((await b.get()).revision, 0);
    await assert.rejects(b.recordEvidence(evidence('persona_approved'), options), { code: 'CLAIM_APPROVAL_EVIDENCE_REQUIRED' });
  }
});

test('agent publication evidence requires both approvals and a preview of the active knowledge', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const repo = createMerchantOnboardingRepository(db, merchantFixture), revision = 'd'.repeat(64);
  await assert.rejects(repo.recordEvidence(evidence('agent_published', { knowledge_revision: revision, agent_url: 'https://chatgpt.com/business/merchant' }), { ...options, activeKnowledgeRevision: revision }), { code: 'BUSINESS_VERIFICATION_EVIDENCE_REQUIRED' });
  await repo.recordEvidence(evidence('claim_approved'), options);
  await repo.recordEvidence(evidence('persona_approved'), { ...options, expectedRevision: 1 });
  await assert.rejects(repo.recordEvidence(evidence('agent_published', { knowledge_revision: revision, agent_url: 'https://chatgpt.com/business/merchant' }), { ...options, expectedRevision: 2, activeKnowledgeRevision: revision }), { code: 'CURRENT_AGENT_PREVIEW_REQUIRED' });
  await assert.rejects(repo.recordEvidence(evidence('agent_preview_passed', { knowledge_revision: revision }), { ...options, expectedRevision: 2, activeKnowledgeRevision: 'e'.repeat(64) }), { code: 'CURRENT_KNOWLEDGE_EVIDENCE_REQUIRED' });
  await repo.recordEvidence(evidence('agent_preview_passed', { knowledge_revision: revision }), { ...options, expectedRevision: 2, activeKnowledgeRevision: revision });
  await repo.recordEvidence(evidence('agent_published', { knowledge_revision: revision, agent_url: 'https://chatgpt.com/business/merchant' }), { ...options, expectedRevision: 3, activeKnowledgeRevision: revision });
  const final = await repo.get(); assert.equal(final.reported.agent, 'published'); assert.equal(final.platform_verified, false);
  await repo.recordEvidence(evidence('claim_rejected'), { ...options, expectedRevision: 4 });
  assert.equal((await repo.get()).reported.agent, 'not_started');
});

test('the prepared pack uses current approved knowledge and never fabricates a product feed', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const knowledge = createMerchantKnowledgeRepository(db, merchantFixture), onboarding = createMerchantOnboardingRepository(db, merchantFixture);
  const saved = await knowledge.saveVersion({ facts: [approvedFact({ internal_note: 'PRIVATE NEGOTIATION' })] }, options);
  await knowledge.activateVersion(saved.revision, { ...options, expectedRevision: null });
  const pack = await onboarding.preparePack(await knowledge.getActive({ now: fixtureNow }), { now: fixtureNow });
  assert.equal(pack.knowledge_revision, saved.revision);
  assert.equal(pack.approved_public_facts[0].value, '100% wool');
  assert.equal(pack.product_feed.generated, false); assert.equal(pack.official_status_verified, false);
  assert.equal(pack.submission_mode, 'manual_in_business_hub');
  assert.equal(pack.capabilities.native_chatwoot_bridge, false);
  assert.equal(JSON.stringify(pack).includes('PRIVATE NEGOTIATION'), false);
  await assert.rejects(onboarding.preparePack({ ...(await knowledge.getActive()), merchant_id: 'merchant-two' }), { code: 'APPROVED_MERCHANT_KNOWLEDGE_REQUIRED' });
});

test('missing proof, unsafe proof URLs and future observations cannot enter the claim record', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const repo = createMerchantOnboardingRepository(db, merchantFixture);
  await assert.rejects(repo.recordEvidence(evidence('claim_approved', { artifact_sha256: 'missing' }), options), { code: 'INVALID_CLAIM_EVIDENCE' });
  await assert.rejects(repo.recordEvidence(evidence('claim_approved', { official_url: 'https://evil.example/approved' }), options), { code: 'OFFICIAL_BUSINESS_HUB_URL_REQUIRED' });
  await assert.rejects(repo.recordEvidence(evidence('claim_approved', { observed_at: '2030-01-01T00:00:00Z' }), options), { code: 'FUTURE_CLAIM_EVIDENCE' });
  await assert.rejects(repo.recordEvidence(evidence('claim_approved', { artifact_ref: 'https://private.example/id-card' }), options), { code: 'OPAQUE_EVIDENCE_REFERENCE_REQUIRED' });
  assert.equal((await repo.get()).revision, 0);
});

test('revoking a merchant binding makes old recorded states unavailable', async t => {
  const db = merchantTestDatabase(); t.after(() => db.close());
  const repo = createMerchantOnboardingRepository(db, merchantFixture);
  const original = evidence('claim_approved');
  await repo.recordEvidence(original, options);
  const other = createMerchantOnboardingRepository(db, { ...merchantFixture, authorizationRef: 'new-authority' });
  await assert.rejects(other.get(), { code: 'CLAIM_STATE_BINDING_MISMATCH' });
  await assert.rejects(other.recordEvidence(original, options), { code: 'CLAIM_STATE_BINDING_MISMATCH' });
  assert.throws(() => prepareBusinessHubPack(merchantFixture, null), /APPROVED_MERCHANT_KNOWLEDGE_REQUIRED/);
});
