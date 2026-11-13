import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildStudioSite, startBuyerSiteWorker } from './worker.mjs';

if (Number(process.versions.node.split('.')[0]) !== 24)
  throw Error('Worker acceptance requires Node 24.');

const configured = process.env.BUYERSITE_WORKER_ACCEPTANCE_DIR;
const dataDir = configured
  ? resolve(configured)
  : await mkdtemp(join(tmpdir(), 'buyer-site-worker-acceptance-'));
const removeAfter = !configured;
if (configured) await mkdir(dataDir, { recursive: false, mode: 0o700 });

const enterpriseId = 'ent_synthetic_worker_acceptance';
const productId = 'prd_' + randomUUID();
const bridgeToken = 'acceptance_bridge_token_1234567890_ABCDEFGHIJK';
const makeInput = (marker, revision) => {
  const snapshot = {
    enterprise: {
      id: enterpriseId,
      company: {
        revision,
        displayName: 'Synthetic Worker Acceptance Supplier',
        description: `Synthetic worker isolation record ${marker}`,
      },
    },
    products: [
      {
        id: productId,
        revision,
        status: 'draft',
        name: 'Shared Slug Acceptance Component',
        category: 'Components',
        description: `Selected synthetic worker record ${marker}`,
      },
    ],
    collectionAuthorized: true,
    website: 'https://example.com/',
  };
  const sourceBytes = Buffer.from(JSON.stringify(snapshot));
  return {
    sourceBytes,
    job: {
      id: randomUUID(),
      enterpriseId,
      outputKind: 'site',
      sourceHash: createHash('sha256').update(sourceBytes).digest('hex'),
      input: { allowResearch: true, productIds: [productId], url: snapshot.website },
    },
  };
};

const first = makeInput('FIRST_BUILD_MARKER', 31);
const second = makeInput('SECOND_BUILD_MARKER', 32);
const headers = {
  'content-type': 'application/json',
  'x-enterprise-id': enterpriseId,
  'x-magazine-bridge': bridgeToken,
};
let builds = 0;
let worker;
let summary;

const submit = async (input) => {
  const response = await fetch(worker.url + '/site-jobs', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      job: input.job,
      sourceBytesBase64: input.sourceBytes.toString('base64'),
    }),
  });
  assert.equal(response.status, 202);
  await worker.idle();
  const status = await (await fetch(worker.url + '/site-jobs/' + input.job.id, { headers })).json();
  assert.equal(status.state, 'READY', JSON.stringify(status));
  return status;
};

try {
  worker = await startBuyerSiteWorker({
    bridgeToken,
    dataDir,
    port: 0,
    buildJob: (args) => {
      builds++;
      const snapshot = JSON.parse(args.sourceBytes.toString('utf8'));
      return buildStudioSite({
        ...args,
        capture: async (url) => ({
          url,
          title: 'Synthetic worker acceptance source',
          captured_at: '2026-11-13T16:00:00.000Z',
          body_text: snapshot.enterprise.company.description,
        }),
      });
    },
  });
  const firstStatus = await submit(first);
  const secondStatus = await submit(second);
  assert.equal(builds, 2);

  const supplierRoute = '/preview/suppliers/synthetic-worker-acceptance-supplier/';
  const preview = await fetch(worker.url + '/site-jobs/' + second.job.id + supplierRoute, {
    headers,
  });
  const html = await preview.text();
  assert.equal(preview.status, 200);
  assert.match(html, /SECOND_BUILD_MARKER/);
  assert.doesNotMatch(html, /FIRST_BUILD_MARKER/);

  for (const input of [first, second]) {
    const check = await readFile(join(dataDir, input.job.id, 'logs', 'check.log'), 'utf8');
    assert.doesNotMatch(check, /multiple entries with the same slug/);
  }

  await worker.close();
  worker = undefined;
  const restarted = await startBuyerSiteWorker({
    bridgeToken,
    dataDir,
    port: 0,
    buildJob: async () => assert.fail('READY jobs must not rebuild after restart'),
  });
  worker = restarted;
  const restartedStatus = await (
    await fetch(restarted.url + '/site-jobs/' + second.job.id, { headers })
  ).json();
  assert.equal(restartedStatus.state, 'READY');
  assert.equal(builds, 2);

  summary = {
    version: '1.0.0',
    result: 'PASS',
    synthetic_only: true,
    production_deployed: false,
    first_job: {
      id: first.job.id,
      state: firstStatus.state,
      revision: firstStatus.revision,
      artifact_sha256: firstStatus.artifactHash,
    },
    second_job: {
      id: second.job.id,
      state: secondStatus.state,
      revision: secondStatus.revision,
      artifact_sha256: secondStatus.artifactHash,
    },
    builds: 2,
    private_preview_status: preview.status,
    previous_content_leaked: false,
    duplicate_slug_warnings: false,
    ready_job_rebuilt_after_restart: false,
  };
  await writeFile(join(dataDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  if (worker) await worker.close();
  if (removeAfter) await rm(dataDir, { recursive: true, force: true });
}
