import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startBuyerSiteWorker } from './worker.mjs';

const TOKEN = 'worker_bridge_token_1234567890_ABCDEFGHIJKLMN';
const enterpriseId = 'ent_synthetic_worker';

function fixture() {
  const snapshot = {
    enterprise: {
      id: enterpriseId,
      company: {
        revision: 3,
        displayName: 'Synthetic Worker Supplier',
        description: 'Synthetic worker contract fixture.',
        website: 'https://example.com/',
      },
    },
    products: [],
    collectionAuthorized: true,
    website: 'https://example.com/',
  };
  const bytes = Buffer.from(JSON.stringify(snapshot));
  return {
    bytes,
    body: {
      job: {
        id: randomUUID(),
        enterpriseId,
        outputKind: 'site',
        sourceHash: createHash('sha256').update(bytes).digest('hex'),
        input: { allowResearch: true, productIds: [], url: snapshot.website },
      },
      sourceBytesBase64: bytes.toString('base64'),
    },
  };
}

async function fakeBuild({ job, jobDir }) {
  const artifactDir = join(jobDir, 'artifact-fixture');
  await mkdir(join(artifactDir, 'products'), { recursive: true });
  await writeFile(
    join(artifactDir, 'index.html'),
    '<!doctype html><h1>Private synthetic preview</h1>',
  );
  await writeFile(join(artifactDir, 'products', 'index.html'), '<!doctype html><h1>Products</h1>');
  return {
    artifactDir,
    revision: 'site_fixture',
    sourceBinding: {
      job_id: job.id,
      enterprise_id: job.enterpriseId,
      source_sha256: job.sourceHash,
      company_revision: 3,
      product_revisions: [],
    },
  };
}

async function request(
  worker,
  path,
  { method = 'GET', body, enterprise = enterpriseId, token = TOKEN } = {},
) {
  return fetch(worker.url + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-enterprise-id': enterprise,
      'x-magazine-bridge': token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('durable local worker queues one site build and serves only tenant-bound private routes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'buyer-site-worker-'));
  const input = fixture();
  let builds = 0;
  const worker = await startBuyerSiteWorker({
    bridgeToken: TOKEN,
    dataDir,
    port: 0,
    buildJob: async (args) => {
      builds++;
      return fakeBuild(args);
    },
  });
  try {
    const created = await request(worker, '/site-jobs', { method: 'POST', body: input.body });
    assert.equal(created.status, 202);
    assert.equal((await created.json()).state, 'QUEUED');
    await worker.idle();

    const status = await request(worker, '/site-jobs/' + input.body.job.id);
    assert.equal(status.status, 200);
    const ready = await status.json();
    assert.equal(ready.state, 'READY');
    assert.equal(ready.enterpriseId, enterpriseId);
    assert.equal(ready.publication, 'BLOCKED');
    assert.match(ready.revision, /^site_/);
    assert.ok(!JSON.stringify(ready).includes('sourceBytesBase64'));

    const page = await request(worker, '/site-jobs/' + input.body.job.id + '/preview/');
    assert.equal(page.status, 200);
    assert.equal(await page.text(), '<!doctype html><h1>Private synthetic preview</h1>');
    assert.equal(page.headers.get('cache-control'), 'private, no-store, max-age=0');
    assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.match(page.headers.get('content-security-policy'), /connect-src 'none'/);

    const nested = await request(worker, '/site-jobs/' + input.body.job.id + '/preview/products/');
    assert.equal(nested.status, 200);
    assert.match(await nested.text(), /Products/);

    await writeFile(
      join(dataDir, input.body.job.id, 'artifact-fixture', 'index.html'),
      '<!doctype html><h1>Tampered</h1>',
    );
    const changed = await request(worker, '/site-jobs/' + input.body.job.id + '/preview/');
    assert.equal(changed.status, 503);
    assert.equal((await changed.json()).error, 'PREVIEW_ARTIFACT_CHANGED');

    const replay = await request(worker, '/site-jobs', { method: 'POST', body: input.body });
    assert.equal(replay.status, 200);
    assert.equal(builds, 1);

    const hidden = await request(worker, '/site-jobs/' + input.body.job.id, {
      enterprise: 'ent_other',
    });
    assert.equal(hidden.status, 404);
    const unauthorized = await request(worker, '/site-jobs/' + input.body.job.id, {
      token: 'x'.repeat(40),
    });
    assert.equal(unauthorized.status, 401);
    const source = await request(worker, '/site-jobs/' + input.body.job.id + '/source.json');
    assert.equal(source.status, 404);
    const lookalike = await request(worker, '/site-jobs/' + input.body.job.id + '/previewevil');
    assert.equal(lookalike.status, 404);
    assert.equal((await lookalike.json()).error, 'SITE_JOB_NOT_FOUND');

    const conflict = structuredClone(input.body);
    conflict.sourceBytesBase64 = Buffer.from('{}').toString('base64');
    conflict.job.sourceHash = createHash('sha256').update('{}').digest('hex');
    const rejected = await request(worker, '/site-jobs', { method: 'POST', body: conflict });
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error, 'SITE_JOB_CONFLICT');
  } finally {
    await worker.close();
  }

  const restarted = await startBuyerSiteWorker({
    bridgeToken: TOKEN,
    dataDir,
    port: 0,
    buildJob: async () => assert.fail('READY job must not rebuild after restart'),
  });
  try {
    const status = await request(restarted, '/site-jobs/' + input.body.job.id);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).state, 'READY');
    const stored = JSON.parse(await readFile(join(dataDir, input.body.job.id, 'job.json'), 'utf8'));
    assert.equal(stored.state, 'READY');
    assert.equal(stored.enterpriseId, enterpriseId);
  } finally {
    await restarted.close();
  }
});

test('worker rejects a browser-chosen enterprise, wrong output kind and unsafe binding', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'buyer-site-worker-deny-'));
  const worker = await startBuyerSiteWorker({
    bridgeToken: TOKEN,
    dataDir,
    port: 0,
    buildJob: fakeBuild,
  });
  try {
    const input = fixture();
    input.body.job.enterpriseId = 'ent_other';
    let response = await request(worker, '/site-jobs', { method: 'POST', body: input.body });
    assert.equal(response.status, 422);
    assert.equal((await response.json()).error, 'SITE_JOB_BINDING_REQUIRED');

    input.body.job.enterpriseId = enterpriseId;
    input.body.job.outputKind = 'pdf';
    response = await request(worker, '/site-jobs', { method: 'POST', body: input.body });
    assert.equal(response.status, 422);

    response = await request(worker, '/site-jobs', {
      method: 'POST',
      body: { ...input.body, extraScope: 'ent_other' },
    });
    assert.equal(response.status, 422);
  } finally {
    await worker.close();
  }
});

test('a failed durable job can be replayed without replacing its frozen source', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'buyer-site-worker-retry-'));
  const input = fixture();
  let attempts = 0;
  const worker = await startBuyerSiteWorker({
    bridgeToken: TOKEN,
    dataDir,
    port: 0,
    buildJob: async (args) => {
      attempts++;
      if (attempts === 1) {
        throw Object.assign(new Error('Synthetic first-attempt failure'), {
          code: 'SYNTHETIC_BUILD_FAILURE',
        });
      }
      return fakeBuild(args);
    },
  });
  try {
    let response = await request(worker, '/site-jobs', { method: 'POST', body: input.body });
    assert.equal(response.status, 202);
    await worker.idle();
    response = await request(worker, '/site-jobs/' + input.body.job.id);
    assert.equal((await response.json()).state, 'FAILED');

    response = await request(worker, '/site-jobs', { method: 'POST', body: input.body });
    assert.equal(response.status, 202);
    await worker.idle();
    response = await request(worker, '/site-jobs/' + input.body.job.id);
    assert.equal((await response.json()).state, 'READY');
    assert.equal(attempts, 2);
    assert.deepEqual(await readFile(join(dataDir, input.body.job.id, 'source.json')), input.bytes);
  } finally {
    await worker.close();
  }
});
