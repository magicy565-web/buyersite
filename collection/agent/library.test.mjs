import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createEnterpriseLibraryAdapter } from './library.mjs';

const enterpriseId = 'ent_' + 'a'.repeat(32);
const documentId = 'doc_11111111-1111-4111-8111-111111111111';
const otherDocumentId = 'doc_22222222-2222-4222-8222-222222222222';
const documentPath = '/api/enterprise/library/documents/' + documentId;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const envelope = (value) => json({ ok: true, data: value });
const profile = {
  id: enterpriseId,
  company: { id: 'company', revision: 1, displayName: 'Synthetic supplier fixture' },
};

function fixture({
  bytes = Buffer.from('Synthetic evidence: model A has a 10 mm inlet.'),
  binary = false,
} = {}) {
  const version = {
    version: 1,
    fileName: binary ? 'brochure.pdf' : 'description.txt',
    mimeType: binary ? 'application/pdf' : 'text/plain; charset=utf-8',
    content: binary ? '' : bytes.toString(),
    bytes: bytes.length,
    sha256: sha(bytes),
    attachment: binary
      ? { attachmentId: 'sha256:' + sha(bytes), name: 'brochure.pdf', bytes: bytes.length }
      : null,
  };
  const document = {
    id: documentId,
    revision: 1,
    companyId: 'company',
    title: 'Synthetic supplier document',
    status: 'active',
    currentVersion: 1,
    versions: [version],
    reviews: [],
  };
  const calls = [];
  let profileReads = 0,
    documentReads = 0;
  const state = {
    document,
    bytes,
    profile,
    afterProfile: null,
    afterDocument: null,
    responses: null,
  };
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    calls.push({ url: target, options });
    if (state.responses) return state.responses(target, options);
    if (target.pathname === '/api/enterprise')
      return json(++profileReads > 1 && state.afterProfile ? state.afterProfile : state.profile);
    if (target.pathname === documentPath)
      return envelope({
        document: ++documentReads > 1 && state.afterDocument ? state.afterDocument : state.document,
        reviewState: 'unreviewed',
      });
    if (target.pathname === documentPath + '/versions/1/file') return new Response(state.bytes);
    throw new Error('Unexpected fixture path');
  };
  const adapter = createEnterpriseLibraryAdapter({
    baseUrl: 'http://127.0.0.1:8799',
    enterpriseId,
    headers: { authorization: 'Bearer synthetic-test-capability' },
    fetchImpl,
  });
  return { adapter, state, calls };
}

test('reads the actual inline document contract with tenant binding and an exact version hash', async () => {
  const { adapter, state, calls } = fixture();
  const result = await adapter.readDocument({ documentId });
  assert.equal(result.source_id, 'library:' + documentId);
  assert.equal(result.revision, '1');
  assert.equal(result.enterprise_id, enterpriseId);
  assert.deepEqual(result.entity, {
    type: 'company',
    id: enterpriseId,
    label: profile.company.displayName,
  });
  assert.equal(result.filename, 'description.txt');
  assert.equal(result.media_type, 'text/plain');
  assert.equal(result.sha256, sha(state.bytes));
  assert.deepEqual(result.bytes, state.bytes);
  assert.equal(result.review_state, 'unreviewed');
  assert.equal(result.is_current_version, true);
  assert.deepEqual(
    calls.map((c) => c.url.pathname),
    ['/api/enterprise', documentPath, documentPath, '/api/enterprise'],
  );
});

test('reads binary attachments only through the pinned authenticated route', async () => {
  const { adapter, state, calls } = fixture({
    binary: true,
    bytes: Buffer.from('%PDF-1.7\nSynthetic fixture only'),
  });
  const entity = { type: 'product', id: 'synthetic-product', label: 'Synthetic pump' };
  const result = await adapter.readDocument({ documentId, version: 1, entity });
  assert.deepEqual(result.entity, entity);
  assert.deepEqual(result.bytes, state.bytes);
  assert.equal(result.media_type, 'application/pdf');
  assert.equal(calls[2].url.pathname, documentPath + '/versions/1/file');
  for (const call of calls) {
    assert.equal(call.url.origin, 'http://127.0.0.1:8799');
    assert.equal(call.options.method, 'GET');
    assert.equal(call.options.redirect, 'error');
    assert.equal(call.options.headers.get('authorization'), 'Bearer synthetic-test-capability');
  }
});

test('lists all active pages using hasMore, nextOffset and sequence from the real API', async () => {
  const { adapter, state, calls } = fixture();
  state.responses = async (url) => {
    if (url.pathname === '/api/enterprise') return json(profile);
    const offset = Number(url.searchParams.get('offset'));
    assert.equal(url.pathname, '/api/enterprise/library/documents');
    assert.equal(url.searchParams.get('status'), 'active');
    assert.equal(url.searchParams.get('limit'), '200');
    return envelope({
      items: [
        {
          id: offset ? otherDocumentId : documentId,
          title: 'Synthetic fixture',
          status: 'active',
          revision: 4,
          currentVersion: 2,
          slotKey: 'specification',
          reviewState: 'unreviewed',
          hasFile: true,
          hasInlineText: false,
        },
      ],
      total: 9,
      matched: 2,
      slotCounts: {},
      sequence: 7,
      offset,
      hasMore: offset === 0,
      nextOffset: offset ? null : 1,
    });
  };
  const result = await adapter.listDocuments();
  assert.equal(result.length, 2);
  assert.equal(result[1].document_id, otherDocumentId);
  assert.equal(result[1].revision, '2');
  assert.equal(result[1].document_revision, 4);
  assert.equal(calls.length, 4);
});

test('rejects a changing library sequence while paginating', async () => {
  const { adapter, state } = fixture();
  state.responses = async (url) =>
    url.pathname === '/api/enterprise'
      ? json(profile)
      : envelope({
          items: [
            {
              id: url.searchParams.get('offset') === '0' ? documentId : otherDocumentId,
              title: 'Synthetic fixture',
              status: 'active',
              revision: 1,
              currentVersion: 1,
            },
          ],
          offset: Number(url.searchParams.get('offset')),
          sequence: Number(url.searchParams.get('offset')) + 1,
          hasMore: url.searchParams.get('offset') === '0',
          nextOffset: 1,
        });
  await assert.rejects(adapter.listDocuments(), { code: 'LIBRARY_SOURCE_CHANGED' });
});

test('rejects mismatched authenticated tenant before requesting document data', async () => {
  const { adapter, state, calls } = fixture();
  state.profile = { ...profile, id: 'ent_' + 'b'.repeat(32) };
  await assert.rejects(adapter.readDocument({ documentId }), { code: 'LIBRARY_SCOPE_MISMATCH' });
  assert.equal(calls.length, 1);
});

test('rejects a tenant binding changed during the read', async () => {
  const { adapter, state } = fixture();
  state.afterProfile = { ...profile, id: 'ent_' + 'b'.repeat(32) };
  await assert.rejects(adapter.readDocument({ documentId }), { code: 'LIBRARY_SCOPE_MISMATCH' });
});

test('rejects binary hash and byte-count mismatches', async (t) => {
  for (const replacement of [
    Buffer.from('wrong content'),
    Buffer.from('longer replacement fixture'),
  ]) {
    await t.test(replacement.toString(), async () => {
      const { adapter, state } = fixture({ binary: true, bytes: Buffer.from('valid content') });
      state.bytes = replacement;
      await assert.rejects(adapter.readDocument({ documentId }), {
        code: 'LIBRARY_SOURCE_CHANGED',
      });
    });
  }
});

test('rechecks metadata after reading bytes and refuses changed or archived sources', async (t) => {
  for (const change of ['hash', 'archived', 'missing-version']) {
    await t.test(change, async () => {
      const { adapter, state } = fixture();
      state.afterDocument = structuredClone(state.document);
      if (change === 'hash') state.afterDocument.versions[0].sha256 = 'b'.repeat(64);
      if (change === 'archived') state.afterDocument.status = 'archived';
      if (change === 'missing-version') state.afterDocument.versions = [];
      await assert.rejects(adapter.readDocument({ documentId }), (error) =>
        [
          'LIBRARY_SOURCE_CHANGED',
          'LIBRARY_SOURCE_UNAVAILABLE',
          'LIBRARY_VERSION_NOT_FOUND',
        ].includes(error.code),
      );
    });
  }
});

test('keeps an exact historical version when a newer one appears, with its own review state', async () => {
  const { adapter, state } = fixture();
  state.afterDocument = structuredClone(state.document);
  state.afterDocument.currentVersion = 2;
  state.afterDocument.revision = 3;
  state.afterDocument.versions.push({ ...state.document.versions[0], version: 2 });
  state.afterDocument.reviews = [
    { documentVersion: 1, sha256: state.document.versions[0].sha256, decision: 'rejected' },
    { documentVersion: 2, sha256: state.document.versions[0].sha256, decision: 'verified' },
  ];
  const result = await adapter.readDocument({ documentId });
  assert.equal(result.revision, '1');
  assert.equal(result.is_current_version, false);
  assert.equal(result.review_state, 'rejected');
});

test('rejects oversized metadata declarations before downloading', async () => {
  const { adapter, state, calls } = fixture({ binary: true });
  state.document.versions[0].bytes = 25 * 1024 * 1024 + 1;
  state.document.versions[0].attachment.bytes = state.document.versions[0].bytes;
  await assert.rejects(adapter.readDocument({ documentId }), { code: 'LIBRARY_SOURCE_TOO_LARGE' });
  assert.equal(calls.length, 2);
});

test('bounds streamed downloads even when content-length is absent', async () => {
  const { adapter, state } = fixture({ binary: true });
  state.responses = async (url) => {
    if (url.pathname === '/api/enterprise') return json(profile);
    if (url.pathname === documentPath) return envelope({ document: state.document });
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(25 * 1024 * 1024 + 1));
          controller.close();
        },
      }),
    );
  };
  await assert.rejects(adapter.readDocument({ documentId }), { code: 'LIBRARY_SOURCE_TOO_LARGE' });
});

test('never follows a redirect or forwards credentials to its target', async () => {
  const { adapter, state, calls } = fixture();
  state.responses = async () =>
    new Response(null, { status: 302, headers: { location: 'https://untrusted.example/source' } });
  await assert.rejects(adapter.readDocument({ documentId }), { code: 'LIBRARY_REDIRECT_BLOCKED' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].url.origin, 'http://127.0.0.1:8799');
});

test('validates references and host configuration before any fetch', async () => {
  const { adapter, calls } = fixture();
  await assert.rejects(adapter.readDocument({ documentId: '../private' }), {
    code: 'LIBRARY_INVALID_REFERENCE',
  });
  await assert.rejects(adapter.readDocument({ documentId, version: '1' }), {
    code: 'LIBRARY_INVALID_REFERENCE',
  });
  assert.equal(calls.length, 0);
  for (const baseUrl of [
    'https://user:secret@example.com',
    'http://example.com',
    'https://example.com/path',
    'https://example.com/?tenant=other',
    'file:///tmp/library.json',
  ]) {
    assert.throws(() => createEnterpriseLibraryAdapter({ baseUrl, enterpriseId }), {
      code: 'LIBRARY_CONFIG_REQUIRED',
    });
  }
});

test('reports missing host library authorization without returning upstream secrets', async () => {
  const { adapter, state } = fixture();
  state.responses = async () => new Response('private upstream details', { status: 403 });
  await assert.rejects(
    adapter.readDocument({ documentId }),
    (error) =>
      error.code === 'LIBRARY_AUTH_REQUIRED' &&
      error.status === 403 &&
      !error.message.includes('private upstream details'),
  );
});

test('does not return path traversal or directory names as source filenames', async () => {
  const { adapter, state } = fixture();
  state.document.versions[0].fileName = '../../description.txt';
  assert.equal((await adapter.readDocument({ documentId })).filename, 'description.txt');
  state.document.versions[0].fileName = '..';
  await assert.rejects(adapter.readDocument({ documentId }), { code: 'LIBRARY_INVALID_RESPONSE' });
});
