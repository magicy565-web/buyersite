import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInformationAgent } from './index.mjs';
import { openKnowledgeStore } from './store.mjs';

const tenant = 'synthetic-tenant-a';
const entity = { type: 'product', id: 'synthetic-product', label: 'Synthetic product' };
const requirements = [
  {
    field: 'product.material',
    label: '材质',
    priority: 100,
    question: '请补充材质。',
    why: '材质必须有来源。',
    requested_materials: ['材质说明'],
  },
];
const sourceId = 'library:doc_11111111-1111-4111-8111-111111111111';
const candidateProvider = {
  extract: async ({ segments }) => ({
    facts: [
      {
        field: 'product.material',
        value: segments[0].text,
        confidence: 0.9,
        evidence: [{ segment_id: segments[0].id, quote: segments[0].text }],
      },
    ],
    questions: [],
  }),
};
const asset = (value, { id = sourceId, revision = '1', current = true, target = entity } = {}) => ({
  source_id: id,
  revision,
  enterprise_id: tenant,
  entity: target,
  filename: 'synthetic-material.txt',
  media_type: 'text/plain',
  bytes: Buffer.from(value),
  is_current_version: current,
});
const create = (options = {}) =>
  createInformationAgent({
    databasePath: ':memory:',
    principal: { enterpriseId: tenant, actorId: 'synthetic-human' },
    provider: candidateProvider,
    requirements,
    ...options,
  });

test('reimporting a known version marked historical retires it from current knowledge', async (t) => {
  const agent = create();
  t.after(() => agent.close());
  const original = await agent.ingestAsset(asset('Cotton'));
  agent.reviewFact({ entity, fact_id: original.facts[0].id, action: 'confirm' });
  await agent.ingestAsset(asset('Cotton', { current: false }), { analyze: false });
  const knowledge = agent.getKnowledge({ entity });
  assert.equal(knowledge.sources[0].active, false);
  assert.equal(knowledge.facts[0].stale, true);
  assert.equal(knowledge.learning.confirmed_facts.length, 0);
  assert.equal(knowledge.ready, false);
});

test('out-of-order imports cannot make an older numeric library revision current', async (t) => {
  const agent = create();
  t.after(() => agent.close());
  await agent.ingestAsset(asset('Current material', { revision: '2' }), { analyze: false });
  // Version 1 was read before version 2, but its import finished later.
  try {
    await agent.ingestAsset(asset('Historical material', { revision: '1' }), { analyze: false });
  } catch (error) {
    assert.ok(error.code, 'A rejected stale import needs a typed error');
  }
  const active = agent.getKnowledge({ entity }).sources.filter((item) => item.active);
  assert.deepEqual(
    active.map((item) => item.revision),
    ['2'],
  );
});

test('choosing the existing confirmed value with replace resolves a later conflicting candidate', async (t) => {
  const agent = create();
  t.after(() => agent.close());
  const first = await agent.ingestAsset(asset('Cotton'));
  agent.reviewFact({ entity, fact_id: first.facts[0].id, action: 'confirm' });
  const conflicting = await agent.ingestAsset(asset('Wool', { id: sourceId + '-second' }));
  const result = agent.reviewFact({
    entity,
    fact_id: first.facts[0].id,
    action: 'confirm',
    replace: true,
    reason: 'The later brochure belongs to a different variant; retain the verified material.',
  });
  const knowledge = agent.getKnowledge({ entity });
  assert.equal(
    knowledge.facts.find((fact) => fact.id === conflicting.facts[0].id).status,
    'superseded',
  );
  assert.equal(result.ready, true);
  assert.equal(knowledge.learning.confirmed_facts[0].value, 'Cotton');
});

test('a library configured for another enterprise cannot leak its document catalogue', async (t) => {
  const agent = create({
    principal: { enterpriseId: 'synthetic-tenant-b', actorId: 'synthetic-human-b' },
    library: {
      listDocuments: async () => [
        { enterprise_id: tenant, document_id: 'private-doc', title: 'Tenant A private title' },
      ],
    },
  });
  t.after(() => agent.close());
  await assert.rejects(agent.listLibraryDocuments(), (error) => Boolean(error.code));
});

test('private source database is not readable by other local users in an existing shared directory', () => {
  const folder = mkdtempSync(join(tmpdir(), 'buyersite-core-review-'));
  chmodSync(folder, 0o755);
  const path = join(folder, 'knowledge.sqlite');
  const store = openKnowledgeStore({ path, enterpriseId: tenant, actorId: 'synthetic-human' });
  try {
    assert.equal(statSync(path).mode & 0o077, 0);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('confirmed corrections persist across restart and actually reach the next extraction', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'buyersite-core-learning-'));
  const databasePath = join(folder, 'knowledge.sqlite');
  const observed = [];
  let agent = create({ databasePath });
  try {
    const initial = await agent.ingestAsset(asset('Cotton'));
    agent.reviewFact({
      entity,
      fact_id: initial.facts[0].id,
      action: 'correct',
      value: 'Polyester',
      reason: 'The label was misread; the current product is polyester.',
      request_id: 'synthetic-correction-1',
    });
    agent.close();
    agent = create({
      databasePath,
      provider: {
        extract: async (context) => {
          observed.push(structuredClone(context.learning));
          return candidateProvider.extract(context);
        },
      },
    });
    const later = await agent.ingestAsset(asset('Polyester', { id: sourceId + '-later' }));
    assert.ok(observed[0].confirmed_facts.some((fact) => fact.value === 'Polyester'));
    assert.ok(
      observed[0].correction_examples.some(
        (correction) =>
          correction.previous_value === 'Cotton' && correction.corrected_value === 'Polyester',
      ),
    );
    assert.equal(
      later.facts[0].status,
      'candidate',
      'Remembered correction must not auto-confirm new evidence',
    );
    await agent.ingestAsset(
      asset('Silk', { id: sourceId + '-other', target: { ...entity, id: 'other-product' } }),
    );
    assert.deepEqual(observed[1].confirmed_facts, []);
    assert.deepEqual(observed[1].correction_examples, []);
  } finally {
    agent.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('one forged quotation rejects the whole semantic response while retaining the source for retry', async (t) => {
  const agent = create({
    provider: {
      extract: async (context) => ({
        facts: [
          (await candidateProvider.extract(context)).facts[0],
          {
            field: 'product.material',
            value: 'Invented material',
            confidence: 1,
            evidence: [
              { segment_id: context.segments[0].id, quote: 'Words absent from the source' },
            ],
          },
        ],
        questions: [],
      }),
    },
  });
  t.after(() => agent.close());
  await assert.rejects(agent.ingestAsset(asset('Cotton')), { code: 'INVALID_EVIDENCE' });
  const knowledge = agent.getKnowledge({ entity });
  assert.deepEqual(knowledge.facts, []);
  assert.equal(knowledge.sources.length, 1);
  assert.equal(knowledge.summary.pending_sources, 1);
});

test('a failed conflicting human answer rolls back its source, parse, fact and audit writes', async (t) => {
  const agent = create();
  t.after(() => agent.close());
  const first = await agent.ingestAsset(asset('Cotton'));
  agent.reviewFact({ entity, fact_id: first.facts[0].id, action: 'confirm' });
  await agent.ingestAsset(asset('Wool', { id: sourceId + '-conflicting' }));
  const before = agent.getKnowledge({ entity });
  const beforeAudit = agent.audit();
  const question = before.questions.find((item) => item.field === 'product.material');
  assert.throws(
    () =>
      agent.answerQuestion({
        entity,
        question_id: question.id,
        answer: 'Silk',
        request_id: 'synthetic-failed-answer',
      }),
    { code: 'CONFIRMED_CONFLICT' },
  );
  const after = agent.getKnowledge({ entity });
  assert.equal(after.sources.length, before.sources.length);
  assert.equal(after.facts.length, before.facts.length);
  assert.deepEqual(agent.audit(), beforeAudit);
});

test('facts and corrections from a shared database stay isolated by authenticated enterprise', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'buyersite-core-tenants-'));
  const databasePath = join(folder, 'knowledge.sqlite');
  const a = create({ databasePath });
  const b = create({
    databasePath,
    principal: { enterpriseId: 'synthetic-tenant-b', actorId: 'synthetic-human-b' },
  });
  try {
    const first = await a.ingestAsset(asset('Cotton'));
    a.reviewFact({
      entity,
      fact_id: first.facts[0].id,
      action: 'correct',
      value: 'Polyester',
      reason: 'Synthetic correction',
      request_id: 'synthetic-correction',
    });
    const bKnowledge = b.getKnowledge({ entity });
    assert.deepEqual(bKnowledge.facts, []);
    assert.deepEqual(bKnowledge.sources, []);
    assert.deepEqual(bKnowledge.learning.correction_examples, []);
    assert.throws(() => b.reviewFact({ entity, fact_id: first.facts[0].id, action: 'confirm' }), {
      code: 'FACT_NOT_FOUND',
    });
    await assert.rejects(b.ingestAsset(asset('Cotton')), { code: 'TENANT_MISMATCH' });
  } finally {
    a.close();
    b.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

function untranscribedAudio(id = sourceId + '-audio') {
  // A valid, silent PCM fixture exercises the missing-ASR route without pretending
  // that a model recognized speech. Its supplementary text is supplied by the host.
  const bytes = Buffer.alloc(48);
  bytes.write('RIFF');
  bytes.writeUInt32LE(40, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(4, 40);
  return {
    ...asset('unused', { id }),
    bytes,
    filename: 'synthetic-recording.wav',
    media_type: 'audio/wav',
  };
}

test('an explicitly linked transcript closes the source gap, keeps facts unconfirmed, and survives restart', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'buyersite-core-supplement-'));
  const databasePath = join(folder, 'knowledge.sqlite');
  const audioId = sourceId + '-audio',
    transcriptId = sourceId + '-transcript';
  let agent = create({ databasePath });
  try {
    const audio = await agent.ingestAsset(untranscribedAudio(audioId));
    assert.equal(audio.status, 'needs_material_or_processor');
    assert.ok(audio.parsed.missing_processors.includes('transcription'));
    const sourceQuestion = agent
      .getNextQuestions({ entity })
      .questions.find((question) => question.source_id === audioId);
    assert.ok(sourceQuestion);

    const transcript = await agent.ingestAsset(asset('Cotton', { id: transcriptId }));
    const beforeLink = agent.getKnowledge({ entity });
    assert.equal(
      beforeLink.summary.pending_sources,
      1,
      'Uploading an unrelated file must not silently resolve the recording',
    );
    assert.ok(beforeLink.questions.some((question) => question.id === sourceQuestion.id));

    const linked = agent.linkSupplement({
      entity,
      question_id: sourceQuestion.id,
      replacement_source_id: transcriptId,
      replacement_revision: '1',
      reason:
        'The host explicitly identifies this supplied transcript as the replacement material for this synthetic recording.',
    });
    assert.equal(linked.summary.pending_sources, 0);
    assert.equal(
      linked.ready,
      false,
      'Linking a source is not confirmation of its extracted facts',
    );
    assert.equal(agent.getKnowledge({ entity }).facts[0].status, 'candidate');
    assert.ok(!linked.questions.some((question) => question.id === sourceQuestion.id));
    assert.equal(
      agent
        .audit()
        .filter((event) => event.action === 'source.analyzed' && event.source_id === audioId)
        .at(-1).status,
      'needs_material_or_processor',
      'The original recording must not be relabelled as parsed',
    );

    const confirmed = agent.reviewFact({
      entity,
      fact_id: transcript.facts[0].id,
      action: 'confirm',
    });
    assert.equal(confirmed.ready, true);
    agent.close();
    agent = create({ databasePath });
    const reopened = agent.getKnowledge({ entity });
    assert.equal(reopened.ready, true);
    assert.equal(reopened.supplements.length, 1);
    assert.equal(reopened.supplements[0].source_id, audioId);
    assert.equal(reopened.supplements[0].replacement_source_id, transcriptId);
    assert.equal(reopened.supplements[0].replacement_revision, '1');
    assert.ok(reopened.sources.some((source) => source.source_id === audioId));
    assert.ok(
      reopened.facts.every((fact) => fact.evidence.every((ref) => ref.source_id !== audioId)),
    );
  } finally {
    agent.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

test('retiring the exact supplementary revision reopens the original source gap instead of silently repinning', async (t) => {
  const agent = create();
  t.after(() => agent.close());
  const audioId = sourceId + '-audio',
    transcriptId = sourceId + '-transcript';
  await agent.ingestAsset(untranscribedAudio(audioId));
  const sourceQuestion = agent
    .getNextQuestions({ entity })
    .questions.find((question) => question.source_id === audioId);
  const transcript = await agent.ingestAsset(asset('Cotton', { id: transcriptId }));
  agent.linkSupplement({
    entity,
    question_id: sourceQuestion.id,
    replacement_source_id: transcriptId,
    replacement_revision: '1',
    reason: 'Explicit supplied transcript link.',
  });
  assert.equal(
    agent.reviewFact({ entity, fact_id: transcript.facts[0].id, action: 'confirm' }).ready,
    true,
  );

  await agent.ingestAsset(asset('Cotton', { id: transcriptId, revision: '2' }));
  const reopened = agent.getKnowledge({ entity });
  assert.equal(reopened.ready, false);
  assert.equal(reopened.summary.pending_sources, 1);
  assert.ok(reopened.questions.some((question) => question.id === sourceQuestion.id));
  assert.equal(
    reopened.supplements[0].replacement_revision,
    '1',
    'A link must remain pinned to the reviewed replacement revision',
  );
  assert.equal(reopened.facts.find((fact) => fact.id === transcript.facts[0].id).stale, true);
  assert.throws(
    () =>
      agent.linkSupplement({
        entity,
        question_id: sourceQuestion.id,
        replacement_source_id: transcriptId,
        replacement_revision: '1',
        reason: 'Do not revive the obsolete transcript.',
      }),
    { code: 'SUPPLEMENT_NOT_READY' },
  );
});

test('supplement links reject other entities, unanalysed files and self-references without recording a link', async (t) => {
  const agent = create();
  t.after(() => agent.close());
  const audioId = sourceId + '-audio';
  await agent.ingestAsset(untranscribedAudio(audioId));
  const sourceQuestion = agent
    .getNextQuestions({ entity })
    .questions.find((question) => question.source_id === audioId);
  const otherId = sourceId + '-other-product-transcript',
    pendingId = sourceId + '-unanalysed-transcript';
  await agent.ingestAsset(
    asset('Cotton', { id: otherId, target: { ...entity, id: 'other-product' } }),
  );
  await agent.ingestAsset(asset('Cotton', { id: pendingId }), { analyze: false });
  const link = (replacement_source_id) =>
    agent.linkSupplement({
      entity,
      question_id: sourceQuestion.id,
      replacement_source_id,
      replacement_revision: '1',
      reason: 'Synthetic proposed source association.',
    });
  assert.throws(() => link(otherId), { code: 'SOURCE_ENTITY_MISMATCH' });
  assert.throws(() => link(pendingId), { code: 'SUPPLEMENT_NOT_READY' });
  assert.throws(() => link(audioId), { code: 'SUPPLEMENT_NOT_READY' });
  assert.deepEqual(agent.getKnowledge({ entity }).supplements, []);
  assert.equal(agent.audit().filter((event) => event.action === 'source.supplemented').length, 0);
  assert.ok(
    agent
      .getNextQuestions({ entity, limit: 100 })
      .questions.some((question) => question.id === sourceQuestion.id),
  );
});
