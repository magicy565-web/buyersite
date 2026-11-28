import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runRequest } from './cli.mjs';
import { createCollectionTools } from './tools.mjs';

const entity = { type: 'product', id: 'synthetic-a100', label: 'Synthetic product A100' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'buyersite-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'library');
  await mkdir(root);
  await writeFile(join(root, 'notes.txt'), 'Model: A100\nMass: 25 kg');
  await writeFile(join(directory, 'outside.txt'), 'Outside the authorized root.');
  const env = {
    KI_ENTERPRISE_ID: 'synthetic-enterprise-one',
    KI_ACTOR_ID: 'synthetic-human-one',
    KI_DATABASE_PATH: join(directory, 'knowledge.sqlite'),
    KI_LIBRARY_ROOT: root,
  };
  return { directory, root, env };
}

test('CLI ingests an authorized local source and reports pending semantic processing without a provider', async (t) => {
  const { env } = await fixture(t);
  const result = await runRequest(
    { command: 'ingest-file', args: { path: 'notes.txt', entity } },
    env,
  );
  assert.equal(result.status, 'needs_semantic_provider');
  assert.equal(result.parsed.status, 'ready');
  assert.equal(result.parsed.segments[0].text, 'Model: A100\nMass: 25 kg');
  assert.equal(result.source.enterprise_id, env.KI_ENTERPRISE_ID);
  assert.equal(result.ready, false);
  assert.ok(result.questions.some((question) => question.reason === 'processor_or_material'));
  const knowledge = await runRequest({ command: 'knowledge', args: { entity } }, env);
  assert.equal(knowledge.sources.length, 1);
  assert.deepEqual(knowledge.facts, []);
  assert.deepEqual(knowledge.learning.confirmed_facts, []);
});

test('CLI rejects parent traversal, absolute outside paths, symlink escapes and directory inputs', async (t) => {
  const { directory, root, env } = await fixture(t);
  await symlink(join(directory, 'outside.txt'), join(root, 'escape.txt'));
  await mkdir(join(directory, 'library-other'));
  await writeFile(join(directory, 'library-other', 'prefix.txt'), 'Outside sibling.');
  await mkdir(join(root, 'subdirectory'));
  for (const path of [
    '../outside.txt',
    join(directory, 'outside.txt'),
    'escape.txt',
    '../library-other/prefix.txt',
    '.',
  ]) {
    await assert.rejects(runRequest({ command: 'ingest-file', args: { path, entity } }, env), {
      code: 'OUTSIDE_LIBRARY_ROOT',
    });
  }
  await assert.rejects(
    runRequest({ command: 'ingest-file', args: { path: 'subdirectory', entity } }, env),
    { code: 'INVALID_ASSET_SIZE' },
  );
  const knowledge = await runRequest({ command: 'knowledge', args: { entity } }, env);
  assert.deepEqual(knowledge.sources, []);
});

test('CLI request JSON cannot choose tenant, actor, provider, database or authorized root', async (t) => {
  const { directory, env } = await fixture(t);
  const untrusted = JSON.parse(
    JSON.stringify({
      command: 'ingest-file',
      enterprise_id: 'synthetic-attacker',
      principal: { enterpriseId: 'synthetic-attacker', actorId: 'synthetic-attacker' },
      env: { KI_ENTERPRISE_ID: 'synthetic-attacker', KI_LIBRARY_ROOT: directory },
      args: {
        path: 'notes.txt',
        entity,
        enterprise_id: 'synthetic-attacker',
        enterpriseId: 'synthetic-attacker',
        actorId: 'synthetic-attacker',
        databasePath: join(directory, 'wrong.sqlite'),
        libraryRoot: directory,
        model: 'untrusted-model',
        apiKey: 'untrusted-credential',
      },
    }),
  );
  const imported = await runRequest(untrusted, env);
  assert.equal(imported.source.enterprise_id, env.KI_ENTERPRISE_ID);
  assert.equal(imported.status, 'needs_semantic_provider');
  const otherTenant = await runRequest(
    { command: 'knowledge', args: { entity, enterprise_id: env.KI_ENTERPRISE_ID } },
    { ...env, KI_ENTERPRISE_ID: 'synthetic-enterprise-two' },
  );
  assert.deepEqual(otherTenant.sources, []);
  const audit = await runRequest({ command: 'audit', args: {} }, env);
  assert.ok(audit.length > 0);
  assert.ok(audit.every((event) => event.actor_id === env.KI_ACTOR_ID));
});

test('CLI needs host identity and rejects unknown commands including prototype names', async (t) => {
  const { env } = await fixture(t);
  await assert.rejects(
    runRequest({ command: 'questions', args: { entity } }, { ...env, KI_ENTERPRISE_ID: '' }),
    { code: 'INVALID_INPUT' },
  );
  for (const command of ['not-a-command', 'constructor', 'toString', '__proto__']) {
    await assert.rejects(runRequest({ command, args: {} }, env), { code: 'UNKNOWN_COMMAND' });
  }
});

test('extraction tool surface cannot approve, correct, answer or defer its own knowledge', async () => {
  const calls = [];
  const agent = {
    listLibraryDocuments: async () => {
      calls.push('list');
      return [];
    },
    ingestLibraryDocument: async (args) => {
      calls.push(['ingest', args]);
      return { status: 'pending' };
    },
    analyzeSource: async (args) => {
      calls.push(['analyze', args]);
      return { status: 'pending' };
    },
    getKnowledge: async (args) => {
      calls.push(['read', args]);
      return { facts: [] };
    },
    getNextQuestions: async (args) => {
      calls.push(['questions', args]);
      return { ready: false };
    },
    reviewFact: () => {
      throw new Error('Review must never be exposed to extraction.');
    },
    answerQuestion: () => {
      throw new Error('Answer must never be exposed to extraction.');
    },
    deferQuestion: () => {
      throw new Error('Deferral must never be exposed to extraction.');
    },
  };
  const tools = createCollectionTools(agent);
  assert.equal(tools.definitions.length, 5);
  assert.ok(
    tools.definitions.every(
      (definition) => !/review|confirm|correct|answer|defer/.test(definition.name),
    ),
  );
  await tools.call('enterprise_knowledge_questions', { entity, limit: 2 });
  assert.deepEqual(calls, [['questions', { entity, limit: 2 }]]);
  for (const name of [
    'enterprise_knowledge_review',
    'enterprise_knowledge_answer',
    'enterprise_knowledge_defer',
    'constructor',
  ]) {
    await assert.rejects(tools.call(name, { entity }), { code: 'INVALID_TOOL_CALL' });
  }
  for (const extra of [
    { enterpriseId: 'other' },
    { action: 'confirm' },
    { constructor: 'prototype escape' },
  ]) {
    await assert.rejects(tools.call('enterprise_knowledge_read', { entity, ...extra }), {
      code: 'INVALID_TOOL_CALL',
    });
  }
});
