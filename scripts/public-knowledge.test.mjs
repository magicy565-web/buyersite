import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPublicKnowledge, structuredSubjects } from './public-knowledge.mjs';

const fact = { evidence_id: 'composition', claim: 'Composition', value: '100% wool', source_url: 'https://supplier.example/material', status: 'supplier-stated', captured_at: '2026-11-18T13:00:00Z', publication_permission: 'approved' };
const brief = { page_path: '/materials/wool/', title: 'Wool review', product_name: 'Wool', product_id: 'wool', supplier_id: 'mill', source_url: fact.source_url, summary: 'Check its specification.', evidence_ids: ['composition'], unconfirmed: [{ id: 'price', label: 'Price', detail: 'Request a quote.' }], questions: [{ id: 'sample', label: 'Sample', prompt: 'Confirm sample cost.' }] };
const build = (overrides = {}) => buildPublicKnowledge({ siteSlug: 'notes', name: 'Notes', origin: 'https://notes.example', briefs: [brief], evidence: [fact], ...overrides });

test('public knowledge preserves source boundaries, unknowns and a reproducible content revision', () => {
  const knowledge = build();
  assert.equal(knowledge.evidence[0].verification, 'not-independently-verified');
  assert.equal(knowledge.evidence[0].valid_until, null);
  assert.equal(knowledge.briefs[0].unconfirmed[0].status, 'unconfirmed');
  assert.equal(knowledge.revision, build().revision);
  assert.notEqual(knowledge.revision, build({ evidence: [{ ...fact, value: 'Changed' }] }).revision);
  const [subject] = structuredSubjects(knowledge, '/materials/wool');
  assert.equal(subject['@type'], 'Product');
  assert.equal(subject.additionalProperty[0].value, '100% wool');
  assert.equal(subject.offers, undefined);
  assert.equal(subject.image, undefined);
});

test('unapproved, unsourced or unsafe source facts cannot leak through their brief', () => {
  for (const change of [{ publication_permission: 'internal-only' }, { source_url: null }, { source_url: 'javascript:alert(1)' }, { source_url: 'https://user:secret@supplier.example/' }]) {
    const result = build({ evidence: [{ ...fact, ...change }], briefs: [{ ...brief, summary: 'Internal-only detail' }] });
    assert.deepEqual(result.evidence, []);
    assert.deepEqual(result.briefs, []);
    assert.ok(!JSON.stringify(result).includes('Internal-only detail'));
  }
});

test('normalized duplicate paths fail closed and plain guides do not become products', () => {
  assert.throws(() => build({ briefs: [brief, { ...brief, page_path: '/materials/wool' }] }), /DUPLICATE_PUBLIC_BRIEF/);
  assert.throws(() => build({ evidence: [fact, fact] }), /DUPLICATE_PUBLIC_EVIDENCE/);
  const data = build({ briefs: [{ ...brief, product_id: null, product_name: '' }] });
  assert.equal(structuredSubjects(data, '/materials/wool/')[0]['@type'], 'CreativeWork');
});
