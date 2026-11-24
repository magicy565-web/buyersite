import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { runMerchantSupportCli } from './merchant-support.mjs';

const token = 'owner-test-token-that-is-longer-than-thirty-two-characters';
const env = { BUYERSITE_MERCHANT_ADMIN_ORIGIN: 'https://merchant.example', BUYERSITE_ADMIN_TOKEN: token };
const asJson = (value, init = {}) => new Response(JSON.stringify(value), { ...init, headers: { 'Content-Type': 'application/json', ...init.headers } });
async function run(args, { fetchFn, stdin = '', ...options } = {}) {
  let output = '', errors = ''; const calls = [];
  const code = await runMerchantSupportCli(args, {
    env, stdin: Readable.from([stdin]), stdout: { write: value => { output += value; } }, stderr: { write: value => { errors += value; } },
    fetchFn: async (url, init) => { calls.push({ url, init }); return fetchFn ? fetchFn(url, init) : asJson({ ok: true }); }, ...options,
  });
  return { code, output, errors, calls };
}
async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'merchant-support-cli-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test('help and invalid commands cannot issue a request or require a token', async () => {
  const help = await run(['--help'], { env: {} });
  assert.equal(help.code, 0); assert.match(help.output, /BUYERSITE_ADMIN_TOKEN/); assert.equal(help.calls.length, 0);
  for (const args of [[], ['publish'], ['status', 'unexpected'], ['claim-pack', '--out'], ['knowledge-save'], ['knowledge-save', '--data', '{}']]) {
    const result = await run(args);
    assert.equal(result.code, 1); assert.equal(result.calls.length, 0);
  }
});

test('status uses only the exact owner origin and never prints echoed credentials', async () => {
  const result = await run(['status'], { fetchFn: () => asJson({ status: 'owner_recorded', authorization: 'unexpected-secret', accessToken: 'another-secret',
    api_key: 'key-secret', note: `response echoed ${token}`, nested: { [token]: token } }) });
  assert.equal(result.code, 0); assert.equal(result.errors, '');
  assert.equal(result.calls[0].url, 'https://merchant.example/api/buyer/admin/merchant-support');
  const request = result.calls[0].init;
  assert.equal(request.method, 'GET'); assert.equal(request.body, undefined);
  assert.equal(request.headers.Authorization, `Bearer ${token}`);
  assert.equal(request.redirect, 'error'); assert.equal(request.credentials, 'omit');
  assert.equal(request.cache, 'no-store'); assert.ok(request.signal instanceof AbortSignal);
  for (const secret of [token, 'unexpected-secret', 'another-secret', 'key-secret']) assert.equal(result.output.includes(secret), false);
  assert.equal(JSON.parse(result.output).status, 'owner_recorded');
});

test('write commands forward bounded JSON to their fixed routes only', async t => {
  const dir = await directory(t), file = join(dir, 'knowledge.json');
  const input = { facts: [{ merchant_id: 'merchant-one', evidence_id: 'public-fact' }], source_revision: 'owner-reviewed' };
  await writeFile(file, JSON.stringify(input));
  const saved = await run(['knowledge-save', file]);
  assert.equal(saved.code, 0); assert.equal(saved.calls[0].init.method, 'POST');
  assert.equal(saved.calls[0].url, 'https://merchant.example/api/buyer/admin/merchant-support/knowledge');
  assert.deepEqual(JSON.parse(saved.calls[0].init.body), input);
  const activation = { revision: 'a'.repeat(64), expectedRevision: null };
  const activated = await run(['knowledge-activate', '-'], { stdin: JSON.stringify(activation) });
  assert.equal(activated.code, 0); assert.equal(activated.calls[0].url.endsWith('/knowledge/activate'), true);
  assert.deepEqual(JSON.parse(activated.calls[0].init.body), activation);
  const evidence = { expectedRevision: 0, event_id: 'a127dbee-a62f-4d88-9140-23e21d33b753', kind: 'claim_submitted',
    artifact_ref: 'redacted:claim-1', artifact_sha256: 'b'.repeat(64), observed_at: '2026-11-24T01:00:00Z', official_url: 'https://chatgpt.com/business-hub' };
  const claim = await run(['claim-evidence', '-'], { stdin: JSON.stringify(evidence) });
  assert.equal(claim.code, 0); assert.equal(claim.calls[0].url.endsWith('/claim-evidence'), true);
  assert.deepEqual(JSON.parse(claim.calls[0].init.body), evidence);
});

test('claim-pack can create a private local file without overwriting an existing file', async t => {
  const dir = await directory(t), output = join(dir, 'pack.json');
  const pack = { schema_version: 'merchant-business-hub-pack-v1', official_status_verified: false, note: token };
  const saved = await run(['claim-pack', '--out', output], { fetchFn: () => asJson(pack) });
  assert.equal(saved.code, 0); assert.equal(saved.output, 'Claim pack saved.\n');
  assert.equal(saved.calls[0].init.method, 'GET'); assert.equal(saved.calls[0].url.endsWith('/claim-pack'), true);
  const body = await readFile(output, 'utf8');
  assert.equal(body.includes(token), false); assert.equal(JSON.parse(body).official_status_verified, false);
  assert.equal((await stat(output)).mode & 0o077, 0);
  const repeated = await run(['claim-pack', '--out', output]);
  assert.equal(repeated.code, 1); assert.match(repeated.errors, /never overwritten/);
  assert.equal(await readFile(output, 'utf8'), body);
});

test('unsafe origins and invalid credentials fail before network access', async () => {
  for (const origin of ['http://merchant.example', 'https://user:password@merchant.example', 'https://merchant.example/api',
    'https://merchant.example?token=x', 'https://merchant.example/#x', 'https://localhost', 'https://localhost.',
    'https://127.0.0.1', 'https://[::1]', 'https://merchant.internal', 'https://merchant.example\\@evil.example', ' https://merchant.example']) {
    const result = await run(['status'], { env: { ...env, BUYERSITE_MERCHANT_ADMIN_ORIGIN: origin } });
    assert.equal(result.code, 1, origin); assert.equal(result.calls.length, 0, origin);
  }
  for (const bad of ['', 'short', 'x'.repeat(513), 'x'.repeat(32) + '\n']) {
    const result = await run(['status'], { env: { ...env, BUYERSITE_ADMIN_TOKEN: bad } });
    assert.equal(result.code, 1); assert.equal(result.calls.length, 0);
  }
});

test('invalid, oversized and nonregular input never reaches the server', async t => {
  for (const input of ['[]', 'null', 'not JSON', '{"facts":[{}],"claimed":true}', 'x'.repeat(512_001), Buffer.from([0xff])]) {
    const result = await run(['knowledge-save', '-'], { stdin: input });
    assert.equal(result.code, 1); assert.equal(result.calls.length, 0);
  }
  const dir = await directory(t), file = join(dir, 'large.json'), link = join(dir, 'link.json');
  await writeFile(file, 'x'.repeat(512_001)); await symlink(file, link);
  for (const path of [dir, file, link, join(dir, 'missing.json')]) {
    const result = await run(['knowledge-save', path]);
    assert.equal(result.code, 1); assert.equal(result.calls.length, 0);
  }
});

test('owner revision and trusted server options cannot be forged through command input', async () => {
  for (const body of [{ revision: 'a'.repeat(64) }, { revision: 'a'.repeat(64), expectedRevision: null, actorId: 'owner' },
    { revision: 'invalid', expectedRevision: null }]) {
    const result = await run(['knowledge-activate', '-'], { stdin: JSON.stringify(body) });
    assert.equal(result.code, 1); assert.equal(result.calls.length, 0);
  }
  const result = await run(['claim-evidence', '-'], { stdin: JSON.stringify({ expectedRevision: 0, platform_verified: true, activeKnowledgeRevision: 'a'.repeat(64) }) });
  assert.equal(result.code, 1); assert.equal(result.calls.length, 0);
});

test('redirects and unsuccessful responses are not followed, printed, or retried', async () => {
  for (const status of [302, 401, 409, 500]) {
    const result = await run(['status'], { fetchFn: () => asJson({ token, error: 'private upstream response' }, { status, headers: { Location: 'https://different.example' } }) });
    assert.equal(result.code, 1); assert.equal(result.calls.length, 1); assert.equal(result.output, '');
    assert.match(result.errors, new RegExp(`HTTP ${status}`));
    assert.equal(result.errors.includes(token), false); assert.equal(result.errors.includes('private upstream'), false);
  }
  const failure = await run(['status'], { fetchFn: () => { throw Error(`network error with Authorization ${token}`); } });
  assert.equal(failure.code, 1); assert.equal(failure.calls.length, 1);
  assert.equal(failure.errors.includes(token), false); assert.match(failure.errors, /No automatic retry/);
});

test('unexpected or oversized success bodies cannot become usable output', async () => {
  for (const fetchFn of [() => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }),
    () => asJson(['unexpected']), () => new Response('not json', { headers: { 'Content-Type': 'application/json' } }),
    () => asJson({ payload: 'x'.repeat(1_048_576) })]) {
    const result = await run(['status'], { fetchFn });
    assert.equal(result.code, 1); assert.equal(result.output, '');
  }
});
