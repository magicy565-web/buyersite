import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from './gateway.mjs';

const origin = 'https://buyersite.example';
const config = { siteSlug: 'material-notes', enquiriesEnabled: true, allowedPaths: ['/', '/enquiry', '/search', '/materials/wool'] };
const ownerToken = 'test-only-owner-token-012345678901234567890';
const body = {
  material: 'Wool fabric', quantity: '20 metres', application: 'Curtains; confirm technical sheet',
  delivery: 'Lisbon, Portugal; December 2026', email: 'buyer@example.test', name: 'Test buyer',
  company: 'Example buyer', page_path: '/enquiry', consent: true, consent_version: 'buyer-enquiry-v1',
};

function d1(sqlite) {
  return {
    prepare(sql) {
      let values = [];
      const stmt = {
        bind(...args) { values = args; return stmt; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { const result = sqlite.prepare(sql).run(...values); return { meta: { changes: Number(result.changes) } }; },
      };
      return stmt;
    },
  };
}

async function database(t) {
  const directory = await mkdtemp(join(tmpdir(), 'buyersite-gateway-'));
  const file = join(directory, 'buyersite.sqlite');
  let sqlite = new DatabaseSync(file);
  sqlite.exec(await readFile(new URL('../drizzle/0000_buyer_enquiries.sql', import.meta.url), 'utf8'));
  t.after(async () => { sqlite.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get sqlite() { return sqlite; },
    get binding() { return d1(sqlite); },
    reopen() { sqlite.close(); sqlite = new DatabaseSync(file); },
  };
}

function request(path, data, { key = crypto.randomUUID(), headers = {}, method = 'POST' } = {}) {
  return new Request(origin + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: origin, 'Idempotency-Key': key, 'CF-Connecting-IP': '203.0.113.10', ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

test('real SQLite persistence survives reopening and receipt retries do not duplicate enquiries', async (t) => {
  const db = await database(t);
  const gateway = createGateway(config);
  const key = crypto.randomUUID();
  const sent = await gateway.fetch(request('/api/buyer/enquiries', body, { key }), { DB: db.binding });
  assert.equal(sent.status, 201);
  const first = await sent.json();
  assert.equal(first.destination, 'buyersite-editorial-inbox');
  assert.equal(first.supplier_sent, false);
  assert.equal(first.replay, false);
  assert.equal('email' in first, false);
  db.reopen();
  const retry = await gateway.fetch(request('/api/buyer/enquiries', body, { key }), { DB: db.binding });
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).receipt_id, first.receipt_id);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS total FROM buyer_enquiries').get().total, 1);
  const conflict = await gateway.fetch(request('/api/buyer/enquiries', { ...body, quantity: '30 metres' }, { key }), { DB: db.binding });
  assert.equal(conflict.status, 409);
});

test('validation rejects cross-origin, absent consent, wrong edition, oversize and unsupported source pages before storing', async (t) => {
  const db = await database(t);
  const gateway = createGateway(config);
  const variants = [
    [request('/api/buyer/enquiries', body, { headers: { Origin: 'https://other.example' } }), 403],
    [request('/api/buyer/enquiries', { ...body, consent: false }), 400],
    [request('/api/buyer/enquiries', { ...body, site_slug: 'different' }), 400],
    [request('/api/buyer/enquiries', { ...body, email: 'invalid' }), 400],
    [request('/api/buyer/enquiries', { ...body, application: 'x'.repeat(20_000) }), 413],
    [request('/api/buyer/enquiries', { ...body, page_path: '//other.example/private' }), 400],
    [request('/api/buyer/enquiries', { ...body, page_path: '/not-in-edition' }), 400],
    [request('/api/buyer/enquiries', { ...body, website: 'spam.example' }), 400],
  ];
  for (const [req, expected] of variants) assert.equal((await gateway.fetch(req, { DB: db.binding })).status, expected);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS total FROM buyer_enquiries').get().total, 0);
});

test('D1-compatible atomic rate limits survive process restarts and do not store raw addresses', async (t) => {
  const db = await database(t);
  const gateway = createGateway(config);
  for (let i = 0; i < 5; i++) assert.equal((await gateway.fetch(request('/api/buyer/enquiries', body), { DB: db.binding })).status, 201);
  db.reopen();
  const limited = await gateway.fetch(request('/api/buyer/enquiries', body), { DB: db.binding });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('Retry-After')) > 0);
  assert.ok(Number(limited.headers.get('Retry-After')) <= 3_600);
  const rows = db.sqlite.prepare('SELECT * FROM buyer_rate_limits').all();
  assert.equal(rows.length, 1);
  assert.match(rows[0].bucket, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(rows).includes('203.0.113.10'), false);
});

test('only authenticated owner can read or qualify enquiries and storage stays tenant-bound', async (t) => {
  const db = await database(t);
  const gateway = createGateway(config);
  const environment = { DB: db.binding, BUYERSITE_ADMIN_TOKEN: ownerToken };
  const stored = await gateway.fetch(request('/api/buyer/enquiries', body), environment);
  const receipt = await stored.json();
  assert.equal((await gateway.fetch(new Request(origin + '/api/buyer/admin/enquiries'), environment)).status, 401);
  const owner = { Authorization: 'Bearer ' + ownerToken };
  const listed = await gateway.fetch(new Request(origin + '/api/buyer/admin/enquiries', { headers: owner }), environment);
  assert.equal(listed.status, 200);
  const entries = await listed.json();
  assert.equal(entries.items.length, 1);
  assert.equal(entries.items[0].email, body.email);
  assert.equal('payload_hash' in entries.items[0], false);
  const changed = await gateway.fetch(request('/api/buyer/admin/enquiries/' + receipt.receipt_id, { status: 'qualified' }, { method: 'PATCH', headers: owner }), environment);
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).status, 'qualified');
  const other = createGateway({ ...config, siteSlug: 'other-edition' });
  const crossTenant = await other.fetch(new Request(origin + '/api/buyer/admin/enquiries', { headers: owner }), environment);
  assert.equal((await crossTenant.json()).items.length, 0);
});

test('unconfigured and synthetic editions expose honest capabilities and do not invent AI replies', async (t) => {
  const db = await database(t);
  const gateway = createGateway({ ...config, enquiriesEnabled: false });
  const caps = await gateway.fetch(new Request(origin + '/api/buyer/config'), { DB: db.binding });
  assert.deepEqual(await caps.json(), { site_slug: config.siteSlug, enquiries: false, assistant: false, assistant_mode: 'source-guide', source_guide: false, consent_version: 'buyer-enquiry-v1' });
  assert.equal((await gateway.fetch(request('/api/buyer/enquiries', body), { DB: db.binding })).status, 503);
  const response = await gateway.fetch(request('/api/buyer/assistant', { message: 'What is the price?', page_path: '/' }), {
    DB: db.binding, BUYERSITE_SOURCING_URL: 'https://sourcing.example', BUYERSITE_SOURCING_TOKEN: 'test-only-sourcing-token-123456',
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'SOURCING_NOT_CONFIGURED');
});

test('owner cursor retains enquiries received in the same millisecond', async (t) => {
  const db = await database(t);
  const gateway = createGateway(config);
  const environment = { DB: db.binding, BUYERSITE_ADMIN_TOKEN: ownerToken };
  for (let i = 0; i < 3; i++) {
    assert.equal((await gateway.fetch(request('/api/buyer/enquiries', { ...body, quantity: `${i + 1} metres` }), environment)).status, 201);
  }
  db.sqlite.prepare('UPDATE buyer_enquiries SET created_at = ?').run('2026-11-18T12:00:00.000Z');
  const headers = { Authorization: 'Bearer ' + ownerToken };
  const first = await (await gateway.fetch(new Request(origin + '/api/buyer/admin/enquiries?limit=2', { headers }), environment)).json();
  assert.equal(first.items.length, 2);
  assert.ok(first.next_cursor);
  const second = await (await gateway.fetch(new Request(origin + '/api/buyer/admin/enquiries?limit=2&cursor=' + encodeURIComponent(first.next_cursor), { headers }), environment)).json();
  assert.equal(second.items.length, 1);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 3);
  assert.equal(second.next_cursor, null);
});

test('mock upstream contract: server binds the provider session to this site and never forwards client product assertions', async (t) => {
  const db = await database(t);
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json(String(url).endsWith('/sessions') ? { session_id: 'provider-session-1234' } : { answer: 'Confirm the specification with the supplier.' });
  };
  const gateway = createGateway(config, { fetchFn });
  const environment = { DB: db.binding, BUYERSITE_SOURCING_URL: 'https://sourcing.example/gateway', BUYERSITE_SOURCING_TOKEN: 'test-provider-token-123456' };
  const answer = await gateway.fetch(request('/api/buyer/assistant', { message: 'Which width?', page_path: '/materials/wool', product_context: { price: 1 } }), environment);
  assert.equal(answer.status, 200);
  const first = await answer.json();
  assert.notEqual(first.session_id, 'provider-session-1234');
  assert.equal(first.mode, 'connected');
  assert.equal(calls[0].url, 'https://sourcing.example/gateway/v1/public-sites/material-notes/sessions');
  assert.equal(calls[1].options.headers['X-Visitor-Session'], 'provider-session-1234');
  assert.equal(JSON.parse(calls[1].options.body).product_context, null);
  assert.equal(calls[1].options.redirect, 'error');
  const second = await gateway.fetch(request('/api/buyer/assistant', { message: 'What else?', page_path: '/' }, { headers: { 'X-Buyer-Session': first.session_id } }), environment);
  assert.equal(second.status, 200);
  assert.equal(calls.length, 3);
  const other = createGateway({ ...config, siteSlug: 'other-edition' }, { fetchFn });
  const invalid = await other.fetch(request('/api/buyer/assistant', { message: 'Continue', page_path: '/' }, { headers: { 'X-Buyer-Session': first.session_id } }), environment);
  assert.equal(invalid.status, 401);
  assert.equal(calls.length, 3);
});
