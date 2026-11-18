import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleAnalytics } from './analytics.mjs';

const origin = 'https://buyersite.example';
const config = { siteSlug: 'material-notes', analyticsEnabled: true, allowedPaths: ['/', '/enquiry', '/materials/wool'] };

function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const file of ['0000_buyer_enquiries.sql', '0001_buyer_events.sql']) sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  return {
    sqlite,
    DB: {
      prepare(sql) {
        let values = [];
        const statement = {
          bind(...args) { values = args; return statement; },
          async first() { return sqlite.prepare(sql).get(...values) ?? null; },
          async run() { return sqlite.prepare(sql).run(...values); },
        };
        return statement;
      },
    },
  };
}

function request(body, headers = {}) {
  return new Request(origin + '/api/events', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.20', ...headers }, body: JSON.stringify(body),
  });
}

test('real SQLite event counters aggregate repeated actions by site/day/path without raw addresses or visitor identities', async (t) => {
  const { sqlite, DB } = setup(t);
  for (let i = 0; i < 3; i++) {
    assert.equal((await handleAnalytics(request({ name: 'page_view', path: '/materials/wool/' }), { DB }, config)).status, 204);
  }
  assert.equal((await handleAnalytics(request({ name: 'enquiry_started', path: '/enquiry' }), { DB }, config)).status, 204);
  const rows = sqlite.prepare('SELECT * FROM buyer_event_daily ORDER BY event').all();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.event === 'page_view').count, 3);
  assert.equal(rows.find((row) => row.event === 'page_view').path, '/materials/wool');
  assert.equal(rows[0].site_slug, config.siteSlug);
  assert.match(rows[0].day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(rows[0]).sort(), ['count', 'day', 'event', 'path', 'site_slug']);
  const rate = sqlite.prepare('SELECT * FROM buyer_rate_limits').get();
  assert.match(rate.bucket, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify({ rows, rate }), /203\.0\.113\.20|visitor_id|session_id|email/);
});

test('analytics excludes PII payloads, foreign origins, unknown paths, tracking opt-outs and malformed objects', async (t) => {
  const { sqlite, DB } = setup(t);
  const valid = { name: 'page_view', path: '/' };
  const cases = [
    [request({ ...valid, email: 'private@example.test' }), 400],
    [request(valid, { Origin: 'https://other.example' }), 403],
    [request(valid, { 'Sec-Fetch-Site': 'cross-site' }), 403],
    [request({ ...valid, path: '/unpublished-secret' }), 400],
    [request({ ...valid, path: '/?email=private@example.test' }), 400],
    [request(valid, { DNT: '1' }), 204],
    [request(valid, { 'Sec-GPC': '1' }), 204],
    [request(null), 400],
  ];
  for (const [req, expected] of cases) assert.equal((await handleAnalytics(req, { DB }, config)).status, expected);
  assert.equal((await handleAnalytics(request(valid), { DB }, { ...config, analyticsEnabled: false })).status, 204);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM buyer_event_daily').get().count, 0);
});
