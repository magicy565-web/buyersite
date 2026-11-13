import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSiteFromStudio } from './from-enterprise.mjs';

function nativeFixture() {
  const snapshot = {
    enterprise: {
      id: 'ent_synthetic_native',
      company: {
        revision: 9,
        displayName: 'Synthetic Native Supplier',
        description: 'Synthetic native snapshot for adapter verification only.',
        website: 'https://example.com/',
      },
    },
    products: [
      {
        id: 'prd_' + randomUUID(),
        revision: 4,
        status: 'draft',
        name: 'Native Catalog Product',
        category: 'Components',
        description: 'A synthetic native catalog record.',
        skus: [
          {
            internalMargin: 'PRIVATE_MARGIN_SENTINEL',
            priceTiers: [{ unitPrice: 'PRIVATE_PRICE_SENTINEL' }],
          },
        ],
      },
    ],
    documents: [{ content: 'PRIVATE_DOCUMENT_SENTINEL' }],
    assets: [{ name: 'UNAPPROVED_IMAGE_SENTINEL' }],
    collectionAuthorized: true,
  };
  const bytes = Buffer.from(JSON.stringify(snapshot, null, 2));
  const job = {
    id: randomUUID(),
    enterpriseId: snapshot.enterprise.id,
    sourceHash: createHash('sha256').update(bytes).digest('hex'),
    input: { allowResearch: true, productIds: [snapshot.products[0].id] },
  };
  return { snapshot, bytes, job };
}
const source = {
  url: 'https://example.com/',
  title: 'Synthetic native source',
  captured_at: '2026-11-13T00:00:00Z',
  body_text:
    'Native Catalog Product is a synthetic fixture used only to exercise source-bound input adaptation. No real enterprise is represented.',
};

test('native Studio job binds the actual source bytes and allowlists public-facing fields', async () => {
  const f = nativeFixture(),
    root = await mkdtemp(join(tmpdir(), 'studio-site-'));
  try {
    let target;
    const built = await createSiteFromStudio(f.job, f.bytes, {
      outputBase: root,
      capture: async (url) => {
        target = url;
        return source;
      },
    });
    assert.equal(target, f.snapshot.enterprise.company.website);
    assert.equal(built.source_binding.enterprise_id, f.job.enterpriseId);
    assert.equal(built.source_binding.source_sha256, f.job.sourceHash);
    assert.deepEqual(built.source_binding.product_revisions, [
      { id: f.snapshot.products[0].id, revision: 4 },
    ]);
    const evidence = await readFile(join(built.root, 'evidence.json'), 'utf8');
    assert.ok(evidence.includes('Native Catalog Product'));
    assert.doesNotMatch(evidence, /PRIVATE_|UNAPPROVED_IMAGE/);
    const receipt = JSON.parse(await readFile(join(built.root, 'receipt.json'), 'utf8'));
    assert.equal(receipt.enterprise_revision, 'studio-snapshot-' + f.job.sourceHash);
    assert.equal(receipt.preview_only, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects cross-enterprise input, altered bytes and missing capture permission before calling the collector', async () => {
  const f = nativeFixture();
  let captures = 0;
  const options = {
    capture: async () => {
      captures++;
      return source;
    },
  };
  await assert.rejects(
    createSiteFromStudio({ ...f.job, enterpriseId: 'ent_other' }, f.bytes, options),
    { code: 'STUDIO_ENTERPRISE_MISMATCH' },
  );
  await assert.rejects(
    createSiteFromStudio(f.job, Buffer.concat([f.bytes, Buffer.from(' ')]), options),
    { code: 'STUDIO_SOURCE_CHANGED' },
  );
  await assert.rejects(
    createSiteFromStudio(
      { ...f.job, input: { ...f.job.input, allowResearch: false } },
      f.bytes,
      options,
    ),
    { code: 'STUDIO_WEBSITE_PERMISSION_REQUIRED' },
  );
  await assert.rejects(
    createSiteFromStudio({ ...f.job, sourceHash: undefined }, f.bytes, options),
    { code: 'STUDIO_SOURCE_BINDING_REQUIRED' },
  );
  assert.equal(captures, 0);
});
