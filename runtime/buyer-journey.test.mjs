import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIEF_HANDOFF_KEY, captureJourney, readJourney, clearJourney, privacyOptOut, saveBriefHandoff, readBriefHandoff, normalizeKnownPath } from '../src/lib/buyer-journey.mjs';

function session() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
const siteSlug = 'material-notes';
const articlePaths = ['/materials/wool/', '/suppliers/mill/'];
const allowedPaths = ['/', '/enquiry', '/search', ...articlePaths];
const contexts = [{ page_path: articlePaths[0], questions: [{ id: 'sample', prompt: 'Confirm sample charges.' }] }];
const options = { siteSlug, articlePaths, allowedPaths };

test('session preserves original landing/campaign across internal navigation and retains latest published article', () => {
  const storage = session();
  captureJourney(storage, { ...options, path: '/materials/wool/', search: '?utm_source=newsletter&utm_medium=email&utm_campaign=wool-launch&email=private@example.test&gclid=private' });
  captureJourney(storage, { ...options, path: '/suppliers/mill' });
  const journey = captureJourney(storage, { ...options, path: '/enquiry', search: '?utm_source=overwritten&from=https://evil.example' });
  assert.deepEqual(journey, { version: 1, site_slug: siteSlug, landing_path: '/materials/wool', article_path: '/suppliers/mill', campaign: { source: 'newsletter', medium: 'email', campaign: 'wool-launch' } });
  assert.equal(JSON.stringify([...storage.values]).includes('private'), false);
  assert.equal(readJourney(storage, 'other-edition', allowedPaths, articlePaths), null);
  assert.equal(normalizeKnownPath('/materials/wool?email=secret', allowedPaths), null);
  assert.equal(normalizeKnownPath('//other.example', allowedPaths), null);
});

test('privacy opt-outs clear navigation storage; malformed state and personal campaign values are discarded', () => {
  const storage = session();
  captureJourney(storage, { ...options, path: '/', search: '?utm_source=buyer%40example.test&utm_medium=email&utm_campaign=https%3A%2F%2Fevil.example' });
  assert.deepEqual(readJourney(storage, siteSlug, allowedPaths, articlePaths).campaign, { medium: 'email' });
  assert.equal(privacyOptOut({ doNotTrack: '1' }), true);
  assert.equal(privacyOptOut({ globalPrivacyControl: true }), true);
  assert.equal(captureJourney(storage, { ...options, path: '/enquiry', optedOut: true }), null);
  assert.equal(storage.values.size, 0);
  storage.setItem('buyersite:journey:v1:' + siteSlug, JSON.stringify({ version: 1, site_slug: siteSlug, landing_path: 'https://evil.example', article_path: '/materials/wool', campaign: {} }));
  assert.equal(readJourney(storage, siteSlug, allowedPaths, articlePaths), null);
  clearJourney(storage, siteSlug);
  assert.equal(storage.values.size, 0);
  assert.equal(captureJourney({ setItem() { throw Error('blocked'); }, getItem() { return null; } }, { ...options, path: '/' }), null);
});

test('explicit brief handoff is bounded, catalog-scoped, strips unrelated fields and is consumed once', () => {
  const storage = session();
  const draft = { version: 1, site_slug: siteSlug, page_path: '/materials/wool', question_ids: ['sample'], requirements: { quantity: '20 metres', application: 'Curtains', delivery: 'Lisbon', email: 'private@example.test' }, transcript: 'PRIVATE_CHAT' };
  assert.equal(saveBriefHandoff(storage, draft, contexts), true);
  assert.doesNotMatch(storage.getItem(BRIEF_HANDOFF_KEY), /private|PRIVATE|email|transcript/);
  assert.equal(readBriefHandoff(storage, siteSlug, contexts).requirements.quantity, '20 metres');
  assert.equal(readBriefHandoff(storage, siteSlug, contexts), null);
  assert.equal(saveBriefHandoff(storage, { ...draft, question_ids: ['forged'] }, contexts), false);
  assert.equal(saveBriefHandoff(storage, { ...draft, page_path: '/enquiry' }, contexts), false);
  assert.equal(saveBriefHandoff(storage, { ...draft, requirements: { quantity: 'x'.repeat(201) } }, contexts), false);
  storage.setItem(BRIEF_HANDOFF_KEY, JSON.stringify({ ...draft, site_slug: 'other-site' }));
  assert.equal(readBriefHandoff(storage, siteSlug, contexts), null);
  assert.equal(storage.getItem(BRIEF_HANDOFF_KEY), null);
});

test('receipt storage retains only a bounded same-edition reference and rejects malformed or cross-edition records', async () => {
  const { saveReceipt, readReceipt, clearReceipt } = await import('../src/lib/buyer-journey.mjs');
  const storage = session();
  const receipt = { receipt_id: crypto.randomUUID(), created_at: '2026-11-18T12:00:00.000Z', status: 'new', destination: 'buyersite-editorial-inbox', supplier_sent: false, email: 'PRIVATE@example.test', material: 'PRIVATE_BRIEF' };
  assert.equal(saveReceipt(storage, siteSlug, receipt), true);
  assert.doesNotMatch(JSON.stringify([...storage.values]), /PRIVATE|email/);
  assert.equal('material' in readReceipt(storage, siteSlug), false);
  assert.equal(readReceipt(storage, siteSlug).receipt_id, receipt.receipt_id);
  assert.equal(readReceipt(storage, 'another-edition'), null);
  const key = 'buyersite:receipt:v1:' + siteSlug;
  for (const value of [null, [], { ...receipt, site_slug: 'another-edition' }, { ...receipt, site_slug: siteSlug, receipt_id: 'not-a-receipt' }, { ...receipt, site_slug: siteSlug, supplier_sent: true }, { ...receipt, site_slug: siteSlug, destination: 'supplier' }]) {
    storage.setItem(key, JSON.stringify(value));
    assert.equal(readReceipt(storage, siteSlug), null);
    assert.equal(storage.getItem(key), null);
  }
  storage.setItem(key, 'malformed');
  assert.equal(readReceipt(storage, siteSlug), null);
  assert.equal(saveReceipt({ setItem() { throw Error('denied'); } }, siteSlug, receipt), false);
  saveReceipt(storage, siteSlug, receipt);
  clearReceipt(storage, siteSlug);
  assert.equal(readReceipt(storage, siteSlug), null);
});
