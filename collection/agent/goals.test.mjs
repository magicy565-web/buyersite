import test from 'node:test';
import assert from 'node:assert/strict';
import { assessGaps, buildLearningContext, LEARNING_LIMITS } from './goals.mjs';

const entity = { type: 'product', id: 'a12', label: 'A12 轻质面料' };
const evidence = (method = 'pdf-text') => [
  {
    source_id: 'brochure',
    source_revision: '2',
    sha256: 'a'.repeat(64),
    segment_id: 'page-3',
    quote: '材质：棉 100%',
    method,
  },
];
const fact = (field, value, status = 'confirmed', extra = {}) => ({
  id: `${field}-${value}`,
  entity_key: 'product:a12',
  field,
  value,
  status,
  evidence: evidence(),
  ...extra,
});
const requirement = (field = 'product.material', extra = {}) => ({
  field,
  label: '材质成分',
  priority: 90,
  question: '请说明材质成分。',
  why: '明确实际使用的材质。',
  requested_materials: ['技术规格表'],
  ...extra,
});
const assess = (facts, extra = {}) =>
  assessGaps({ entity, facts, requirements: [requirement()], ...extra });

test('default goals ask only the relevant company or product questions in priority order', () => {
  const product = assessGaps({ entity, facts: [] });
  assert.deepEqual(
    product.questions.map((question) => question.field),
    [
      'product.model',
      'product.name',
      'product.material',
      'product.specifications',
      'product.moq',
      'product.lead_time',
    ],
  );
  assert.equal(product.summary.missing, 6);
  assert.equal(product.ready, false);
  assert.ok(product.questions.every((question) => question.requested_materials.length > 0));
  const company = assessGaps({
    entity: { type: 'company', id: 'factory', label: '工厂' },
    facts: [],
  });
  assert.deepEqual(
    company.questions.map((question) => question.field),
    ['company.display_name', 'company.business_scope'],
  );
});

test('high confidence never confirms a candidate or hides a missing field', () => {
  const result = assess([fact('product.material', '棉 100%', 'candidate', { confidence: 1 })]);
  assert.equal(result.questions[0].reason, 'unconfirmed');
  assert.equal(result.ready, false);
  assert.equal(result.summary.unconfirmed, 1);
  assert.match(result.questions[0].question, /请核对/);
});

test('new candidate that disagrees with a confirmed value creates a conflict without overwriting', () => {
  const facts = [
    fact('product.material', '棉 100%'),
    fact('product.material', '涤纶 100%', 'candidate'),
  ];
  const copy = structuredClone(facts);
  const result = assess(facts);
  assert.equal(result.questions[0].reason, 'conflict');
  assert.match(result.questions[0].question, /棉 100%/);
  assert.match(result.questions[0].question, /涤纶 100%/);
  assert.equal(result.questions[0].candidate_ids.length, 2);
  assert.equal(result.summary.conflict, 1);
  assert.equal(result.ready, false);
  assert.deepEqual(facts, copy);
});

test('same-value candidates reinforce a confirmed fact and rejected or stale rows do not conflict', () => {
  const result = assess([
    fact('product.material', '棉 100%'),
    fact('product.material', ' 棉  100% ', 'candidate'),
    fact('product.material', '涤纶 100%', 'rejected'),
    fact('product.material', '锦纶 100%', 'superseded'),
    fact('product.material', '毛 100%', 'candidate', { stale: true }),
    fact('product.material', '毛 50%', 'confirmed', { entity_key: 'product:other' }),
  ]);
  assert.equal(result.ready, true);
  assert.equal(result.summary.satisfied, 1);
  assert.deepEqual(result.questions, []);
});

test('custom evidence requirement stays open after a user statement and closes with matching source evidence', () => {
  const strict = { requirements: [requirement('product.material', { evidence_required: true })] };
  const statement = fact('product.material', '棉 100%', 'confirmed', {
    evidence: evidence('user-statement'),
  });
  const first = assess([statement], strict);
  assert.equal(first.questions[0].reason, 'evidence_missing');
  assert.match(first.questions[0].question, /技术规格表/);
  assert.equal(first.ready, false);
  const supplied = fact('product.material', '棉 100%', 'candidate', { id: 'new-brochure-fact' });
  const second = assess([statement, supplied], strict);
  assert.equal(second.ready, true);
  assert.deepEqual(second.questions, []);
  assert.equal(assess([statement]).ready, true);
});

test('malformed evidence cannot satisfy a document requirement', () => {
  const result = assess(
    [
      fact('product.material', '棉 100%', 'confirmed', {
        evidence: [{ ...evidence()[0], sha256: 'not-a-source-hash' }],
      }),
    ],
    { requirements: [requirement('product.material', { evidence_required: true })] },
  );
  assert.equal(result.questions[0].reason, 'evidence_missing');
});

test('deferred fields are not asked again or marked ready, and new confirmed evidence satisfies them', () => {
  const deferred = assess([], { deferredFields: ['product.material'] });
  assert.equal(deferred.summary.deferred, 1);
  assert.equal(deferred.summary.missing, 0);
  assert.deepEqual(deferred.questions, []);
  assert.equal(deferred.ready, false);
  const completed = assess([fact('product.material', '棉 100%')], {
    deferredFields: ['product.material'],
  });
  assert.equal(completed.ready, true);
  assert.equal(completed.summary.deferred, 0);
  assert.equal(assess([]).questions[0].reason, 'missing');
});

test('question identity is stable across retries and input order, and changes for another entity', () => {
  const facts = [fact('product.material', '棉'), fact('product.material', '涤纶', 'candidate')];
  const first = assess(facts).questions[0];
  const second = assess([...facts].reverse()).questions[0];
  assert.deepEqual(first, second);
  const other = assess([], { entity: { ...entity, id: 'b23' } }).questions[0];
  assert.notEqual(other.id, assess([]).questions[0].id);
});

test('requirements reject duplicate fields or another entity type', () => {
  assert.throws(() => assess([], { requirements: [requirement(), requirement()] }), {
    code: 'KNOWLEDGE_GOAL_INVALID',
  });
  assert.throws(() => assess([], { requirements: [requirement('company.display_name')] }), {
    code: 'KNOWLEDGE_GOAL_INVALID',
  });
});

test('confirmed correction is available to the next extraction context with bounded provenance', () => {
  const context = buildLearningContext({
    entity,
    facts: [fact('product.name', '轻质面料'), fact('product.material', '棉', 'candidate')],
    corrections: [
      {
        field: 'product.name',
        previous_value: 'A12',
        corrected_value: '轻质面料',
        reason: 'A12 是型号，不是名称。',
      },
    ],
  });
  assert.equal(context.entity_key, 'product:a12');
  assert.deepEqual(
    context.confirmed_facts.map((record) => record.field),
    ['product.name'],
  );
  assert.equal(context.confirmed_facts[0].evidence[0].segment_id, 'page-3');
  assert.equal(context.correction_examples[0].corrected_value, '轻质面料');
  assert.deepEqual(context.disputed_fields, []);
});

test('learning memory excludes conflicting, stale, foreign and explicitly unapproved records', () => {
  const context = buildLearningContext({
    entity,
    facts: [
      fact('product.material', '棉'),
      fact('product.material', '涤纶', 'candidate'),
      fact('product.name', '旧款', 'confirmed', { stale: true }),
      fact('product.model', 'other', 'confirmed', { entity_key: 'product:other' }),
    ],
    corrections: [
      { field: 'product.material', previous_value: '毛', corrected_value: '棉' },
      {
        field: 'product.name',
        previous_value: '旧款',
        corrected_value: '新款',
        status: 'candidate',
      },
      { field: 'product.model', corrected_value: 'b23', confirmed: false },
      { field: 'product.model', corrected_value: 'other', entity_key: 'product:other' },
    ],
  });
  assert.deepEqual(context.confirmed_facts, []);
  assert.deepEqual(context.correction_examples, []);
  assert.deepEqual(context.disputed_fields, ['product.material']);
});

test('learning context is bounded without truncating a fact value into a different fact', () => {
  const facts = Array.from({ length: LEARNING_LIMITS.facts + 2 }, (_, index) =>
    fact(`product.spec_${index}`, `完整值 ${index}`),
  );
  facts.unshift(fact('product.long_specification', 'x'.repeat(2_001)));
  const corrections = Array.from({ length: LEARNING_LIMITS.corrections + 1 }, (_, index) => ({
    field: 'product.name',
    previous_value: `旧称 ${index}`,
    corrected_value: `新称 ${index}`,
    reason: 'r'.repeat(2_000),
  }));
  const context = buildLearningContext({ entity, facts, corrections });
  assert.equal(context.confirmed_facts.length, LEARNING_LIMITS.facts);
  assert.ok(context.confirmed_facts.every((entry) => entry.field !== 'product.long_specification'));
  assert.equal(context.correction_examples.length, LEARNING_LIMITS.corrections);
  assert.equal(context.correction_examples[0].previous_value, '旧称 1');
  assert.ok(context.correction_examples.every((entry) => entry.reason.length <= 1_000));
  assert.deepEqual(context.truncated, { facts: true, corrections: true, disputed_fields: false });
});

test('many disputed custom fields cannot produce an unbounded learning context', () => {
  const facts = Array.from({ length: LEARNING_LIMITS.disputed_fields + 1 }, (_, index) => [
    fact(`product.spec_${index}`, '原值'),
    fact(`product.spec_${index}`, '新值', 'candidate'),
  ]).flat();
  const context = buildLearningContext({ entity, facts });
  assert.equal(context.disputed_fields.length, LEARNING_LIMITS.disputed_fields);
  assert.equal(context.truncated.disputed_fields, true);
  assert.deepEqual(context.confirmed_facts, []);
});
