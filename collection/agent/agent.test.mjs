import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createInformationAgent } from './index.mjs';
import { sha256 } from './contracts.mjs';

const entity = { type: 'product', id: 'a12', label: 'A12 轻质面料' };
const principal = { enterpriseId: 'enterprise-a', actorId: 'expert-1' };
const goal = (field, extra = {}) => ({
  field,
  label: field,
  priority: 90,
  question: `请补充 ${field}。`,
  why: '确认这个型号的资料。',
  requested_materials: ['该型号的原始规格说明'],
  ...extra,
});

// Only semantic inference is mocked. Files, parsing, evidence checks and SQLite are real.
function harness(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'buyersite-agent-'));
  const databasePath = join(directory, 'knowledge.sqlite');
  const opened = [];
  t.after(() => {
    for (const agent of opened) agent.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const open = (overrides = {}) => {
    const agent = createInformationAgent({ databasePath, principal, ...options, ...overrides });
    const close = agent.close;
    let closed = false;
    agent.close = () => {
      if (!closed) {
        closed = true;
        close();
      }
    };
    opened.push(agent);
    return agent;
  };
  return { open, databasePath };
}

function textAsset(text, extra = {}) {
  const bytes = Buffer.from(text, 'utf8');
  return {
    source_id: 'catalogue',
    revision: '1',
    enterprise_id: principal.enterpriseId,
    entity,
    filename: 'catalogue.txt',
    media_type: 'text/plain',
    bytes,
    sha256: sha256(bytes),
    ...extra,
  };
}

function extracted(input, field, value, quote = value) {
  const segment = input.segments.find((item) => item.text.includes(quote));
  assert.ok(segment, `Fixture must quote actual parsed source text: ${quote}`);
  return { field, value, confidence: 0.99, evidence: [{ segment_id: segment.id, quote }] };
}

const singleFieldProvider = (field) => ({
  extract: async (input) => ({
    facts: [extracted(input, field, input.segments[0].text.trim())],
    questions: [],
  }),
});

test('real text and SQLite complete extraction, human correction, restart, learning reuse and supplementary answers', async (t) => {
  const observations = [];
  const provider = {
    extract: async (input) => {
      observations.push(structuredClone(input));
      if (input.source.source_id === 'first-catalogue') {
        return {
          facts: [
            extracted(input, 'product.model', 'A12'),
            extracted(input, 'product.name', 'A12'),
            extracted(input, 'product.material', '棉 100%'),
          ],
          questions: [],
        };
      }
      const learned = input.learning.correction_examples.find(
        (item) => item.field === 'product.name',
      );
      // This fixture intentionally repeats the first mistake unless the recorded correction is reused.
      const name = learned?.corrected_value ?? 'A12';
      return {
        facts: [
          extracted(input, 'product.name', name),
          extracted(input, 'product.material', '棉 100%'),
        ],
        questions: [],
      };
    },
  };
  const fixture = harness(t, {
    provider,
    requirements: [
      goal('product.model'),
      goal('product.name'),
      goal('product.material'),
      goal('product.moq'),
    ],
  });
  let agent = fixture.open();
  const firstAsset = textAsset('型号 A12\n产品名称：轻质面料\n成分：棉 100%', {
    source_id: 'first-catalogue',
  });
  const first = await agent.ingestAsset(firstAsset);
  assert.equal(first.status, 'analyzed');
  assert.ok(first.facts.every((fact) => fact.status === 'candidate'));
  const provenance = first.facts[0].evidence[0];
  assert.equal(provenance.sha256, sha256(firstAsset.bytes));
  assert.equal(provenance.source_revision, '1');
  assert.equal(provenance.method, 'provided-text');
  assert.deepEqual(provenance.locator, { kind: 'lines', start_line: 1, end_line: 3 });
  const initialQuestions = agent.getNextQuestions({ entity, limit: 100 });
  assert.equal(initialQuestions.summary.unconfirmed, 3);
  assert.equal(initialQuestions.summary.missing, 1);
  assert.equal(initialQuestions.ready, false);
  const model = first.facts.find((fact) => fact.field === 'product.model');
  const wrongName = first.facts.find((fact) => fact.field === 'product.name');
  agent.reviewFact({ entity, fact_id: model.id, action: 'confirm' });
  const correction = agent.reviewFact({
    entity,
    fact_id: wrongName.id,
    action: 'correct',
    value: '轻质面料',
    reason: 'A12 是型号，正式产品名称为轻质面料。',
    request_id: 'fix-name',
  });
  assert.equal(correction.fact.value, '轻质面料');
  assert.equal(correction.fact.status, 'confirmed');
  agent.close();

  agent = fixture.open();
  const restored = agent.getKnowledge({ entity });
  assert.equal(restored.facts.find((fact) => fact.id === wrongName.id).status, 'superseded');
  assert.equal(restored.learning.correction_examples[0].previous_value, 'A12');
  assert.equal(restored.learning.correction_examples[0].corrected_value, '轻质面料');
  const second = await agent.ingestAsset(
    textAsset('A12 名称：轻质面料；材质：棉 100%。', { source_id: 'supplement' }),
  );
  assert.equal(second.facts.find((fact) => fact.field === 'product.name').value, '轻质面料');
  assert.equal(observations.length, 2);
  assert.ok(
    observations[1].learning.confirmed_facts.some(
      (fact) => fact.field === 'product.name' && fact.value === '轻质面料',
    ),
  );
  assert.equal(observations[1].learning.correction_examples.length, 1);
  const material = second.facts.find((fact) => fact.field === 'product.material');
  agent.reviewFact({ entity, fact_id: material.id, action: 'confirm' });
  const remaining = agent.getNextQuestions({ entity, limit: 100 });
  assert.equal(remaining.questions.length, 1);
  assert.equal(remaining.questions[0].field, 'product.moq');
  const completed = agent.answerQuestion({
    entity,
    question_id: remaining.questions[0].id,
    answer: '500 米 / 每色',
    request_id: 'answer-moq',
  });
  assert.equal(completed.fact.value, '500 米 / 每色');
  assert.equal(completed.ready, true);
  assert.equal(completed.total_open, 0);
  assert.equal(completed.summary.satisfied, 4);
  assert.ok(agent.audit().some((event) => event.action === 'fact.confirm'));
});

test('reingestion, reparsing and repeated answer requests are idempotent without losing review state', async (t) => {
  const agent = harness(t, {
    provider: singleFieldProvider('product.name'),
    requirements: [goal('product.name'), goal('product.moq')],
  }).open();
  const asset = textAsset('轻质面料');
  const first = await agent.ingestAsset(asset);
  agent.reviewFact({ entity, fact_id: first.facts[0].id, action: 'confirm' });
  const again = await agent.ingestAsset(asset);
  const reparsed = await agent.analyzeSource({
    source_id: asset.source_id,
    revision: '1',
    entity,
    reparse: true,
  });
  assert.equal(again.facts[0].id, first.facts[0].id);
  assert.equal(reparsed.facts[0].id, first.facts[0].id);
  assert.equal(reparsed.facts[0].status, 'confirmed');
  assert.equal(agent.getKnowledge({ entity }).facts.length, 1);
  assert.equal(agent.audit().filter((event) => event.action === 'source.received').length, 1);
  const question = agent.getNextQuestions({ entity }).questions[0];
  const request = {
    entity,
    question_id: question.id,
    answer: '500 米',
    request_id: 'retry-safe-answer',
  };
  const answer = agent.answerQuestion(request);
  const replay = agent.answerQuestion(request);
  assert.equal(replay.fact.id, answer.fact.id);
  assert.equal(replay.ready, true);
  assert.equal(agent.getKnowledge({ entity }).facts.length, 2);
  assert.throws(() => agent.answerQuestion({ ...request, answer: '100 米' }), {
    code: 'REQUEST_CONFLICT',
  });
});

test('enterprises sharing one SQLite file and identifiers cannot read or mutate each other knowledge', async (t) => {
  const fixture = harness(t, {
    provider: singleFieldProvider('product.name'),
    requirements: [goal('product.name')],
  });
  const first = fixture.open();
  const otherPrincipal = { enterpriseId: 'enterprise-b', actorId: principal.actorId };
  const second = fixture.open({ principal: otherPrincipal });
  const firstResult = await first.ingestAsset(textAsset('企业甲产品'));
  const secondResult = await second.ingestAsset(
    textAsset('企业乙产品', { enterprise_id: otherPrincipal.enterpriseId }),
  );
  assert.notEqual(firstResult.facts[0].id, secondResult.facts[0].id);
  first.reviewFact({
    entity,
    fact_id: firstResult.facts[0].id,
    action: 'correct',
    value: '甲正式产品',
    reason: '企业甲确认名称。',
    request_id: 'name-review',
  });
  assert.equal(first.getKnowledge({ entity }).learning.correction_examples.length, 1);
  const otherKnowledge = second.getKnowledge({ entity });
  assert.deepEqual(
    otherKnowledge.facts.map((fact) => fact.value),
    ['企业乙产品'],
  );
  assert.deepEqual(otherKnowledge.learning.correction_examples, []);
  assert.equal(otherKnowledge.sources.length, 1);
  assert.throws(
    () => second.reviewFact({ entity, fact_id: firstResult.facts[0].id, action: 'confirm' }),
    { code: 'FACT_NOT_FOUND' },
  );
  await assert.rejects(second.ingestAsset(textAsset('伪装成其他企业的内容')), {
    code: 'TENANT_MISMATCH',
  });
  await first.ingestAsset(textAsset('甲独有资料', { source_id: 'private-a' }));
  await assert.rejects(second.analyzeSource({ source_id: 'private-a', revision: '1', entity }), {
    code: 'SOURCE_ENTITY_MISMATCH',
  });
  assert.ok(second.audit().every((event) => event.source_id !== 'private-a'));
});

test('immutable revisions keep original evidence while stale versions stop teaching current facts', async (t) => {
  const agent = harness(t, {
    provider: singleFieldProvider('product.material'),
    requirements: [goal('product.material')],
  }).open();
  const firstAsset = textAsset('棉 100%');
  const first = await agent.ingestAsset(firstAsset);
  agent.reviewFact({ entity, fact_id: first.facts[0].id, action: 'confirm' });
  const nextAsset = textAsset('涤纶 100%', { revision: '2' });
  const next = await agent.ingestAsset(nextAsset);
  const knowledge = agent.getKnowledge({ entity });
  const historical = knowledge.facts.find((fact) => fact.id === first.facts[0].id);
  assert.equal(historical.status, 'confirmed');
  assert.equal(historical.stale, true);
  assert.equal(historical.evidence[0].sha256, sha256(firstAsset.bytes));
  assert.equal(next.facts[0].stale, false);
  assert.deepEqual(knowledge.learning.confirmed_facts, []);
  assert.equal(knowledge.questions[0].reason, 'unconfirmed');
  assert.equal(knowledge.summary.conflict, 0);
  await assert.rejects(agent.analyzeSource({ source_id: 'catalogue', revision: '1', entity }), {
    code: 'STALE_SOURCE',
  });
  assert.throws(() => agent.reviewFact({ entity, fact_id: historical.id, action: 'confirm' }), {
    code: 'STALE_EVIDENCE',
  });
  await assert.rejects(agent.ingestAsset(textAsset('篡改同一版本', { revision: '2' })), {
    code: 'SOURCE_VERSION_CONFLICT',
  });
  await assert.rejects(
    agent.ingestAsset(textAsset('错误哈希', { source_id: 'invalid-hash', sha256: '0'.repeat(64) })),
    { code: 'SOURCE_HASH_MISMATCH' },
  );
  assert.equal((await agent.ingestAsset(firstAsset)).status, 'historical');
  assert.equal(
    (await agent.ingestAsset(textAsset('更早资料', { revision: '0', is_current_version: false })))
      .status,
    'historical',
  );
  assert.deepEqual(
    agent
      .getKnowledge({ entity })
      .sources.filter((source) => source.active)
      .map((source) => source.revision),
    ['2'],
  );
});

test('a fabricated quote rejects an entire model response atomically and can be retried after fixing the provider', async (t) => {
  let fabricate = true;
  const provider = {
    extract: async (input) => ({
      facts: [
        extracted(input, 'product.name', '轻质面料'),
        ...(fabricate
          ? [
              {
                field: 'product.material',
                value: '棉 100%',
                confidence: 1,
                evidence: [{ segment_id: input.segments[0].id, quote: '这句话没有出现在原文中' }],
              },
            ]
          : []),
      ],
      questions: [],
    }),
  };
  const agent = harness(t, { provider, requirements: [goal('product.name')] }).open();
  await assert.rejects(agent.ingestAsset(textAsset('轻质面料')), { code: 'INVALID_EVIDENCE' });
  const failed = agent.getKnowledge({ entity });
  assert.deepEqual(failed.facts, []);
  assert.equal(failed.sources.length, 1);
  assert.equal(failed.ready, false);
  const processing = agent
    .getNextQuestions({ entity, limit: 100 })
    .questions.find((question) => question.field.startsWith('$source:'));
  assert.equal(processing.error_code, 'INVALID_EVIDENCE');
  fabricate = false;
  const retried = await agent.analyzeSource({ source_id: 'catalogue', revision: '1', entity });
  assert.equal(retried.status, 'analyzed');
  assert.equal(agent.getKnowledge({ entity }).facts.length, 1);
  assert.equal(retried.summary.pending_sources, 0);
});

test('conflicting evidence does not overwrite confirmed knowledge and replacement requires explicit human resolution', async (t) => {
  const agent = harness(t, {
    provider: singleFieldProvider('product.material'),
    requirements: [goal('product.material')],
  }).open();
  const first = await agent.ingestAsset(textAsset('棉 100%', { source_id: 'first' }));
  agent.reviewFact({ entity, fact_id: first.facts[0].id, action: 'confirm' });
  const next = await agent.ingestAsset(textAsset('涤纶 100%', { source_id: 'second' }));
  assert.equal(next.questions[0].reason, 'conflict');
  assert.equal(next.ready, false);
  assert.deepEqual(agent.getKnowledge({ entity }).learning.confirmed_facts, []);
  assert.throws(() => agent.reviewFact({ entity, fact_id: next.facts[0].id, action: 'confirm' }), {
    code: 'CONFIRMED_CONFLICT',
  });
  assert.equal(
    agent.getKnowledge({ entity }).facts.find((fact) => fact.id === first.facts[0].id).status,
    'confirmed',
  );
  const resolved = agent.reviewFact({
    entity,
    fact_id: next.facts[0].id,
    action: 'confirm',
    replace: true,
    reason: '新资料适用于当前量产版本。',
  });
  assert.equal(resolved.ready, true);
  const knowledge = agent.getKnowledge({ entity });
  assert.equal(knowledge.facts.find((fact) => fact.id === first.facts[0].id).status, 'superseded');
  assert.equal(knowledge.learning.confirmed_facts[0].value, '涤纶 100%');
  assert.equal(knowledge.learning.correction_examples[0].previous_value, '棉 100%');
});

test('human can resolve a new conflict by reaffirming the previously confirmed value', async (t) => {
  const agent = harness(t, {
    provider: singleFieldProvider('product.material'),
    requirements: [goal('product.material')],
  }).open();
  const first = await agent.ingestAsset(
    textAsset('棉 100%', { source_id: 'current-specification' }),
  );
  agent.reviewFact({ entity, fact_id: first.facts[0].id, action: 'confirm' });
  const wrong = await agent.ingestAsset(
    textAsset('涤纶 100%', { source_id: 'wrong-product-page' }),
  );
  assert.equal(wrong.questions[0].reason, 'conflict');
  const resolved = agent.reviewFact({
    entity,
    fact_id: first.facts[0].id,
    action: 'confirm',
    replace: true,
    reason: '另一页属于其他产品，本型号仍以当前规格为准。',
  });
  assert.equal(resolved.ready, true);
  assert.equal(
    agent.getKnowledge({ entity }).facts.find((fact) => fact.id === wrong.facts[0].id).status,
    'superseded',
  );
});

test('same values with formatting whitespace remain equivalent during confirmation as well as gap assessment', async (t) => {
  const agent = harness(t, {
    provider: singleFieldProvider('product.material'),
    requirements: [goal('product.material')],
  }).open();
  const first = await agent.ingestAsset(textAsset('棉 100%', { source_id: 'first-format' }));
  agent.reviewFact({ entity, fact_id: first.facts[0].id, action: 'confirm' });
  const second = await agent.ingestAsset(textAsset('棉  100%', { source_id: 'second-format' }));
  assert.equal(second.ready, true);
  assert.equal(second.questions.length, 0);
  const confirmed = agent.reviewFact({ entity, fact_id: second.facts[0].id, action: 'confirm' });
  assert.equal(confirmed.ready, true);
});

test('documentary requirements remain open after a human statement and close with matching supplementary evidence', async (t) => {
  const agent = harness(t, {
    provider: singleFieldProvider('product.material'),
    requirements: [goal('product.material', { evidence_required: true })],
  }).open();
  const missing = agent.getNextQuestions({ entity }).questions[0];
  const answered = agent.answerQuestion({
    entity,
    question_id: missing.id,
    answer: '棉 100%',
    request_id: 'statement-material',
  });
  assert.equal(answered.fact.status, 'confirmed');
  assert.equal(answered.fact.evidence[0].method, 'user-statement');
  assert.equal(answered.ready, false);
  assert.equal(answered.questions[0].reason, 'evidence_missing');
  const supplied = await agent.ingestAsset(
    textAsset('棉 100%', { source_id: 'material-specification' }),
  );
  assert.equal(supplied.facts[0].status, 'candidate');
  assert.equal(supplied.facts[0].evidence[0].method, 'provided-text');
  assert.equal(supplied.ready, true);
  assert.equal(supplied.total_open, 0);
});

test('additional extracted fields ask for review and conflict resolution without inventing new missing requirements', async (t) => {
  const provider = {
    extract: async (input) => ({
      facts:
        input.source.source_id === 'first-colour'
          ? [
              extracted(input, 'product.name', '轻质面料'),
              extracted(input, 'product.color', '蓝色'),
            ]
          : [extracted(input, 'product.color', '红色')],
      questions: [],
    }),
  };
  const agent = harness(t, { provider, requirements: [goal('product.name')] }).open();
  const first = await agent.ingestAsset(
    textAsset('轻质面料，蓝色。', { source_id: 'first-colour' }),
  );
  const questions = agent.getNextQuestions({ entity, limit: 100 }).questions;
  assert.equal(
    questions.find((question) => question.field === 'product.color')?.reason,
    'unconfirmed',
  );
  assert.ok(
    questions.every((question) => ['product.name', 'product.color'].includes(question.field)),
  );
  for (const fact of first.facts) agent.reviewFact({ entity, fact_id: fact.id, action: 'confirm' });
  assert.equal(agent.getNextQuestions({ entity }).ready, true);
  const conflicting = await agent.ingestAsset(textAsset('红色。', { source_id: 'next-colour' }));
  assert.equal(
    conflicting.questions.find((question) => question.field === 'product.color')?.reason,
    'conflict',
  );
  assert.equal(conflicting.ready, false);
  const resolved = agent.reviewFact({
    entity,
    fact_id: conflicting.facts[0].id,
    action: 'confirm',
    replace: true,
    reason: '确认本次资料适用于红色版本。',
  });
  assert.equal(resolved.ready, true);
});

test('missing audio and semantic processors are explicit and never fabricate extracted facts', async (t) => {
  let extractionCalls = 0;
  const fixture = harness(t, { requirements: [goal('product.name')] });
  const audioAgent = fixture.open({
    provider: {
      extract: async () => {
        extractionCalls++;
        return { facts: [], questions: [] };
      },
    },
  });
  const bytes = Buffer.alloc(46);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(38, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(2, 40);
  const audio = await audioAgent.ingestAsset(
    textAsset('placeholder', {
      source_id: 'voice-note',
      filename: 'voice-note.wav',
      media_type: 'audio/wav',
      bytes,
      sha256: sha256(bytes),
    }),
  );
  assert.equal(audio.status, 'needs_material_or_processor');
  assert.equal(audio.parsed.status, 'needs_processor');
  assert.deepEqual(audio.parsed.missing_processors, ['transcription']);
  assert.equal(extractionCalls, 0);
  assert.deepEqual(audioAgent.getKnowledge({ entity }).facts, []);
  const audioQuestion = audioAgent
    .getNextQuestions({ entity, limit: 100 })
    .questions.find((question) => question.source_id === 'voice-note');
  assert.deepEqual(audioQuestion.missing_processors, ['transcription']);
  assert.throws(
    () =>
      audioAgent.answerQuestion({
        entity,
        question_id: audioQuestion.id,
        answer: '这是一段产品语音。',
        request_id: 'no-fake-processor',
      }),
    { code: 'MATERIAL_REQUIRED' },
  );

  const textEntity = { ...entity, id: 'b23' };
  const textAgent = fixture.open();
  const text = await textAgent.ingestAsset(
    textAsset('另一种面料', { source_id: 'readable-text', entity: textEntity }),
  );
  assert.equal(text.status, 'needs_semantic_provider');
  assert.equal(text.parsed.status, 'ready');
  assert.equal(text.parsed.segments[0].text, '另一种面料');
  assert.deepEqual(textAgent.getKnowledge({ entity: textEntity }).facts, []);
  assert.equal(text.ready, false);
  textAgent.close();
  const configured = fixture.open({ provider: singleFieldProvider('product.name') });
  const processed = await configured.analyzeSource({
    entity: textEntity,
    source_id: 'readable-text',
    revision: '1',
  });
  assert.equal(processed.status, 'analyzed');
  assert.equal(processed.facts[0].value, '另一种面料');
  assert.equal(
    configured.reviewFact({ entity: textEntity, fact_id: processed.facts[0].id, action: 'confirm' })
      .ready,
    true,
  );
});

test('deferred unknown answers remain incomplete, survive a restart, and resume without losing the question', (t) => {
  const fixture = harness(t, { requirements: [goal('product.moq')] });
  let agent = fixture.open();
  const original = agent.getNextQuestions({ entity }).questions[0];
  const deferred = agent.answerQuestion({
    entity,
    question_id: original.id,
    answer: '不知道',
    request_id: 'unknown-moq',
  });
  assert.equal(deferred.ready, false);
  assert.equal(deferred.summary.deferred, 1);
  assert.equal(deferred.questions.length, 0);
  assert.deepEqual(agent.getKnowledge({ entity }).facts, []);
  agent.close();
  agent = fixture.open();
  assert.equal(agent.getNextQuestions({ entity }).summary.deferred, 1);
  const resumed = agent.resumeField({ entity, field: 'product.moq' });
  assert.equal(resumed.questions[0].id, original.id);
  assert.equal(
    agent.answerQuestion({
      entity,
      question_id: original.id,
      answer: '300 米',
      request_id: 'known-moq',
    }).ready,
    true,
  );
});

test('targeted model uncertainty questions close only after an applicable human answer', async (t) => {
  const provider = {
    extract: async () => ({
      facts: [],
      questions: [
        {
          field: 'product.certification',
          question: '这份证书适用于哪个型号？',
          why: '原文未列明型号。',
          requested_materials: ['证书适用范围的说明'],
        },
      ],
    }),
  };
  const agent = harness(t, { provider, requirements: [] }).open();
  const ingested = await agent.ingestAsset(textAsset('证书编号 T-100，适用型号待确认。'));
  assert.equal(ingested.ready, false);
  assert.equal(ingested.questions[0].reason, 'uncertain');
  const answered = agent.answerQuestion({
    entity,
    question_id: ingested.questions[0].id,
    answer: 'T-100 证书适用于 A12。',
    request_id: 'certificate-scope',
  });
  assert.equal(answered.ready, true);
  assert.equal(answered.total_open, 0);
});
