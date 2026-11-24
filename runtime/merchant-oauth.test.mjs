import assert from 'node:assert/strict';
import test from 'node:test';
import { createMerchantOAuthVerifier, MerchantOAuthError, parseOAuthScopes } from './merchant-oauth.mjs';

const ISSUER = 'https://identity.example.test';
const RESOURCE = 'https://shop.example.test/mcp';
const JWKS_URI = `${ISSUER}/jwks.json`;
const SECONDS = 1_800_000_000;
const READ = 'merchant:support:read';
const WRITE = 'merchant:support:write';
const encoder = new TextEncoder();
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2_048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'rotation-1', alg: 'RS256', use: 'sig' };
const payload = { iss: ISSUER, aud: RESOURCE, sub: 'customer-123', iat: SECONDS - 30, exp: SECONDS + 300, scope: `${READ} ${WRITE}` };
const header = { alg: 'RS256', kid: publicKey.kid, typ: 'at+jwt' };

async function token(claims = {}, fields = {}) {
  const unsigned = [Buffer.from(JSON.stringify({ ...header, ...fields })).toString('base64url'), Buffer.from(JSON.stringify({ ...payload, ...claims })).toString('base64url')].join('.');
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, encoder.encode(unsigned));
  return `${unsigned}.${Buffer.from(signature).toString('base64url')}`;
}
function keyResponse(keys = [publicKey], options = {}) { return new Response(JSON.stringify({ keys }), { headers: { 'Content-Type': 'application/json' }, ...options }); }
function setup(options = {}) {
  const requests = [];
  const verify = createMerchantOAuthVerifier({ issuer: ISSUER, audience: RESOURCE, jwksUri: JWKS_URI, now: () => SECONDS * 1_000, fetchFn: async (...args) => { requests.push(args); return keyResponse(); }, ...options });
  return { verify, requests };
}
async function unauthorized(promise, code = 'invalid_token') {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof MerchantOAuthError);
    assert.equal(error.code, code);
    assert.equal(error.status, code === 'insufficient_scope' ? 403 : 401);
    assert.equal(error.message, code === 'insufficient_scope' ? 'The linked account needs additional permission.' : 'Link a valid customer account to continue.');
    return true;
  });
}

test('verifies a real RSA signature and returns only immutable server identity', async () => {
  const { verify, requests } = setup();
  const identity = await verify(await token({ email: 'sensitive@example.test', claimed: true, account_id: 7 }), [WRITE]);
  assert.deepEqual(identity, { issuer: ISSUER, subject: payload.sub, scopes: [READ, WRITE] });
  assert.ok(Object.isFrozen(identity));
  assert.ok(Object.isFrozen(identity.scopes));
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], JWKS_URI);
  assert.equal(requests[0][1].redirect, 'error');
  assert.equal(requests[0][1].method, 'GET');
  assert.ok(requests[0][1].signal instanceof AbortSignal);
  assert.deepEqual(requests[0][1].headers, { Accept: 'application/jwk-set+json, application/json' });
  assert.deepEqual(await verify(await token({ aud: ['https://another.example.test', RESOURCE] }), [READ]), identity);
  assert.equal(requests.length, 1);
});

test('accepts the registered JWK Set JSON media type', async () => {
  const { verify } = setup({ fetchFn: async () => keyResponse([publicKey], { headers: { 'Content-Type': 'application/jwk-set+json' } }) });
  assert.equal((await verify(await token(), [READ])).subject, payload.sub);
});

test('rejects modified signatures and claims even when the JWT still parses', async () => {
  const { verify } = setup();
  const valid = await token();
  const segments = valid.split('.');
  const corrupted = Buffer.from(segments[2], 'base64url');
  corrupted[0] ^= 1;
  await unauthorized(verify(`${segments[0]}.${segments[1]}.${corrupted.toString('base64url')}`, [READ]));
  const changedPayload = Buffer.from(JSON.stringify({ ...payload, sub: 'another-customer' })).toString('base64url');
  await unauthorized(verify(`${segments[0]}.${changedPayload}.${segments[2]}`, [READ]));
});

test('validates issuer, audience, subject, token lifetime and activation before key fetch', async (t) => {
  const cases = {
    'wrong issuer': { iss: 'https://evil.example.test' },
    'issuer suffix': { iss: `${ISSUER}/` },
    'wrong audience': { aud: 'https://another-shop.example.test/mcp' },
    'audience type': { aud: [RESOURCE, 123] },
    'empty subject': { sub: ' ' },
    'control subject': { sub: 'customer\u000aadmin' },
    'oversize subject': { sub: 'c'.repeat(201) },
    'expired': { exp: SECONDS },
    'not active': { nbf: SECONDS + 1 },
    'fractional activation': { nbf: SECONDS - 0.5 },
    'negative activation': { nbf: -1 },
    'future issuance': { iat: SECONDS + 1 },
    'missing issuance': { iat: undefined },
    'fractional expiry': { exp: SECONDS + 300.5 },
    'overlong token': { iat: SECONDS - 3_601 },
    'reversed lifetime': { exp: SECONDS + 1, iat: SECONDS + 2 },
    'invalid scope type': { scope: [READ] },
    'invalid scope separator': { scope: `${READ}\n${WRITE}` },
    'overlong scope': { scope: 's'.repeat(129) },
  };
  for (const [name, claims] of Object.entries(cases)) await t.test(name, async () => {
    const { verify, requests } = setup();
    await unauthorized(verify(await token(claims), [READ]));
    assert.equal(requests.length, 0);
  });
});

test('rejects algorithm confusion, token-directed key URLs and unsupported critical headers', async (t) => {
  const cases = {
    'unsigned': { alg: 'none' }, 'HMAC': { alg: 'HS256' }, 'unsupported RSA mode': { alg: 'PS256' },
    'missing kid': { kid: undefined }, 'path-like kid': { kid: '../secrets' }, 'wrong token type': { typ: 'refresh+jwt' },
    'jku': { jku: 'https://attacker.example.test/keys' }, 'x5u': { x5u: 'http://127.0.0.1/secrets' },
    'jwk': { jwk: publicKey }, 'critical': { crit: ['extra'] }, 'unencoded body': { b64: false },
  };
  for (const [name, fields] of Object.entries(cases)) await t.test(name, async () => {
    const { verify, requests } = setup();
    await unauthorized(verify(await token({}, fields), [READ]));
    assert.equal(requests.length, 0);
  });
});

test('rejects malformed and noncanonical compact JWT input', async (t) => {
  const valid = await token();
  const [head, body, signature] = valid.split('.');
  for (const bad of [null, '', valid + '.extra', `${head}=.${body}.${signature}`, `${head}.${body}.${signature}=`, `!.${body}.${signature}`, `${head}.${Buffer.from('[]').toString('base64url')}.${signature}`, 'x'.repeat(16_385)]) {
    await t.test(String(bad).slice(0, 50), async () => { await unauthorized(setup().verify(bad)); });
  }
});

test('enforces required scopes only after verifying signature', async () => {
  const { verify } = setup();
  await unauthorized(verify(await token({ scope: READ }), [WRITE]), 'insufficient_scope');
  await unauthorized(verify(await token({ scope: undefined }), [READ]), 'insufficient_scope');
  assert.deepEqual(await verify(await token({ scope: `${READ} ${READ}` }), [READ]), { issuer: ISSUER, subject: payload.sub, scopes: [READ] });
  await unauthorized(verify(await token(), ['bad scope']));
});

test('rejects ambiguous, unsuitable and private JWKS signing keys', async (t) => {
  const cases = {
    'duplicate kid': [publicKey, publicKey], 'unknown kid': [{ ...publicKey, kid: 'other' }],
    'symmetric key': [{ ...publicKey, kty: 'oct' }], 'encryption use': [{ ...publicKey, use: 'enc' }],
    'wrong algorithm': [{ ...publicKey, alg: 'RS512' }], 'signing permission': [{ ...publicKey, key_ops: ['sign'] }],
    'private key material': [{ ...publicKey, d: 'secret' }], 'short modulus': [{ ...publicKey, n: 'AQAB' }],
    'oversize modulus': [{ ...publicKey, n: Buffer.alloc(1_025, 255).toString('base64url') }],
    'empty': [], 'too many': Array.from({ length: 33 }, (_, i) => ({ ...publicKey, kid: String(i) })),
  };
  const signed = await token();
  for (const [name, keys] of Object.entries(cases)) await t.test(name, async () => {
    await unauthorized(setup({ fetchFn: async () => keyResponse(keys) }).verify(signed, [READ]));
  });
});

test('fails closed on key-provider failure, content confusion and oversized streams', async (t) => {
  const cases = {
    'network failure': () => { throw new Error('sensitive provider token=secret'); },
    'redirect': () => keyResponse([publicKey], { status: 302, headers: { 'Content-Type': 'application/json', Location: 'https://attacker.example.test' } }),
    'non-json': () => new Response('secret provider details', { headers: { 'Content-Type': 'text/html' } }),
    'content-type suffix': () => new Response('{}', { headers: { 'Content-Type': 'application/json-malicious' } }),
    'malformed': () => new Response('{', { headers: { 'Content-Type': 'application/json' } }),
    'invalid UTF-8': () => new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } }),
    'declared oversized': () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '65537' } }),
    'streamed oversized': () => new Response(' '.repeat(65_537), { headers: { 'Content-Type': 'application/json' } }),
  };
  const signed = await token();
  for (const [name, fetchFn] of Object.entries(cases)) await t.test(name, async () => { await unauthorized(setup({ fetchFn }).verify(signed, [READ])); });
});

test('coalesces concurrent JWKS requests and refreshes keys after the bounded TTL', async () => {
  let current = SECONDS * 1_000;
  let fetches = 0;
  const { verify } = setup({ now: () => current, cacheTtlMs: 10_000, fetchFn: async () => { fetches++; return keyResponse(); } });
  const signed = await token();
  await Promise.all([verify(signed, [READ]), verify(signed, [WRITE]), verify(signed)]);
  assert.equal(fetches, 1);
  current += 10_000;
  await verify(signed, [READ]);
  assert.equal(fetches, 2);
});

test('rechecks expiry after a signing-key fetch completes', async () => {
  let current = SECONDS * 1_000;
  const { verify } = setup({ now: () => current, fetchFn: async () => { current += 2_000; return keyResponse(); } });
  await unauthorized(verify(await token({ exp: SECONDS + 1 }), [READ]));
});

test('requires operator-owned HTTPS settings and bounded verifier options', () => {
  for (const options of [
    { issuer: 'http://identity.example.test' }, { issuer: 'https://user:pass@identity.example.test' },
    { audience: 'https://shop.example.test/mcp?token=1' }, { jwksUri: 'file:///private/key.json' },
    { jwksUri: `${JWKS_URI}#fragment` }, { cacheTtlMs: 300_001 }, { maxTokenLifetimeSeconds: 0 },
    { fetchFn: null }, { now: null },
  ]) assert.throws(() => setup(options), /Invalid OAuth/);
  assert.deepEqual(parseOAuthScopes(''), []);
  assert.deepEqual(parseOAuthScopes(`${READ} ${WRITE} ${READ}`), [READ, WRITE]);
  for (const scopes of [' a', 'a ', 'a  b', 'a\nb', 'a"b', 'a\\b']) assert.throws(() => parseOAuthScopes(scopes), MerchantOAuthError);
});
