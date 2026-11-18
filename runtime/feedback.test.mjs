import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleFeedback } from './feedback.mjs';

const origin = 'https://buyersite.example';
const token = 'test-only-feedback-token-01234567890123456789';
const config = { siteSlug: 'material-notes' };
const now = new Date('2026-11-18T13:30:00.000Z');

function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  for (const file of ['0000_buyer_enquiries.sql', '0001_buyer_events.sql', '0002_enquiry_context.sql']) sqlite.exec(readFileSync(new URL('../drizzle/' + file, import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return statement; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
      };
      return statement;
    },
    async batch(queries) {
      sqlite.exec('BEGIN');
      try { const output = []; for (const query of queries) output.push(await query.all()); sqlite.exec('COMMIT'); return output; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
  return { sqlite, env: { DB, BUYERSITE_ADMIN_TOKEN: token } };
}

function addEnquiry(sqlite, { site = config.siteSlug, date = now.toISOString(), status = 'new', path = '/enquiry', article = null, landing = null, campaign = {}, method = null } = {}) {
  const id = crypto.randomUUID();
  sqlite.prepare(`INSERT INTO buyer_enquiries
    (id, site_slug, idempotency_key_hash, payload_hash, created_at, updated_at, status, email, name, company,
      material, quantity, application, delivery, page_path, attribution_json, consent_version, consent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, site, id, 'private-payload-hash', date, date, status, 'never-return@example.test', 'PRIVATE_CONTACT_NAME',
      'PRIVATE_COMPANY', 'PRIVATE_BRIEF', 'PRIVATE_QUANTITY', 'PRIVATE_APPLICATION', 'PRIVATE_DELIVERY', path, '{}', 'buyer-enquiry-v1', date);
  sqlite.prepare('UPDATE buyer_enquiries SET originating_page_path = ?, landing_page_path = ?, attribution_json = ?, attribution_method = ? WHERE id = ?')
    .run(article, landing, JSON.stringify(campaign), method, id);
}

function request(query = '', auth = true, method = 'GET') {
  return new Request(origin + '/api/buyer/admin/feedback' + query, { method, headers: auth ? { Authorization: 'Bearer ' + token } : {} });
}

test('feedback uses real SQL aggregates, separates submitted events from persisted intent, and excludes contacts/free text', async (t) => {
  const { sqlite, env } = setup(t);
  const insertEvent = sqlite.prepare('INSERT INTO buyer_event_daily VALUES (?, ?, ?, ?, ?)');
  insertEvent.run(config.siteSlug, '2026-11-18', 'page_view', '/materials/wool', 12);
  insertEvent.run(config.siteSlug, '2026-11-18', 'enquiry_submitted', '/enquiry', 99);
  insertEvent.run(config.siteSlug, '2026-10-20', 'page_view', '/', 4);
  insertEvent.run(config.siteSlug, '2026-10-19', 'page_view', '/', 500);
  insertEvent.run('other-site', '2026-11-18', 'page_view', '/', 200);
  addEnquiry(sqlite);
  addEnquiry(sqlite, { status: 'qualified', path: '/materials/wool', date: '2026-10-20T00:00:00.000Z' });
  addEnquiry(sqlite, { status: 'archived' });
  addEnquiry(sqlite, { date: '2026-10-19T23:59:59.999Z' });
  addEnquiry(sqlite, { date: '2026-11-19T00:00:00.000Z' });
  addEnquiry(sqlite, { site: 'other-site' });
  const result = await handleFeedback(request(), env, config, { now });
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  const data = await result.json();
  assert.equal(data.period.start_date, '2026-10-20');
  assert.equal(data.period.end_date, '2026-11-18');
  assert.equal(data.period.time_zone, 'UTC');
  assert.deepEqual(data.enquiries.counts, { total: 3, new: 1, qualified: 1, archived: 1 });
  assert.equal(data.events.totals.find((row) => row.event === 'enquiry_submitted').count, 99);
  assert.equal(data.events.totals.find((row) => row.event === 'page_view').count, 16);
  assert.equal(data.enquiries.by_page.find((row) => row.path === '/materials/wool').qualified, 1);
  assert.equal(data.events.rows_truncated, false);
  assert.match(data.definitions.events, /not unique visitor counts/);
  const serialized = JSON.stringify(data);
  assert.doesNotMatch(serialized, /never-return|PRIVATE_|private-payload-hash|other-site/);
  assert.equal('unique_visitors' in data, false);
});

test('feedback requires owner auth, bounds calendar windows to 90 days and handles empty data without inventing evidence', async (t) => {
  const { env } = setup(t);
  assert.equal((await handleFeedback(request('', false), env, config, { now })).status, 401);
  assert.equal((await handleFeedback(request(), { ...env, BUYERSITE_ADMIN_TOKEN: 'different-owner-token-012345678901234567890' }, config, { now })).status, 401);
  for (const query of ['?days=0', '?days=91', '?days=1.5', '?days=30&days=90', '?email=example']) {
    assert.equal((await handleFeedback(request(query), env, config, { now })).status, 400);
  }
  assert.equal((await handleFeedback(request('', true, 'POST'), env, config, { now })).status, 405);
  const bounded = await handleFeedback(request('?days=90'), env, config, { now });
  assert.equal(bounded.status, 200);
  const data = await bounded.json();
  assert.equal(data.period.days, 90);
  assert.deepEqual(data.events.totals, []);
  assert.deepEqual(data.enquiries.counts, { total: 0, new: 0, qualified: 0, archived: 0 });
  assert.match(data.definitions.scope, /do not establish demand absence/);
  // A malformed adapter result must fail, rather than masquerading as zero demand.
  const broken = { ...env, DB: { ...env.DB, async batch() { return [{ success: true }]; } } };
  assert.equal((await handleFeedback(request(), broken, config, { now })).status, 503);
});

test('context report distinguishes selected article, reported landing and bounded campaign while suppressing unsafe legacy labels', async (t) => {
  const { sqlite, env } = setup(t);
  addEnquiry(sqlite, { article: '/materials/wool', landing: '/', campaign: { source: 'newsletter', medium: 'email', campaign: 'wool-launch' }, method: 'reported-session' });
  addEnquiry(sqlite, { article: '/materials/wool', landing: '/materials/wool', campaign: { source: 'newsletter', medium: 'email', campaign: 'wool-launch' }, method: 'reported-session', status: 'qualified' });
  addEnquiry(sqlite, { article: '/suppliers/mill', method: 'withheld', status: 'archived' });
  addEnquiry(sqlite, { campaign: { source: 'PRIVATE_CAMPAIGN@example.test' } });
  const response = await handleFeedback(request(), env, config, { now });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.enquiries.counts, { total: 4, new: 2, qualified: 1, archived: 1 });
  assert.equal(data.enquiries.by_originating_article.find((row) => row.path === '/materials/wool').total, 2);
  assert.equal(data.enquiries.by_landing_page.find((row) => row.path === '/').total, 1);
  assert.equal(data.enquiries.by_campaign.find((row) => row.source === 'newsletter').total, 2);
  assert.equal(data.enquiries.by_campaign.find((row) => !row.source).total, 2);
  assert.equal(data.enquiries.by_attribution_method.find((row) => row.method === 'withheld').archived, 1);
  assert.match(data.definitions.attribution, /not independently verified/);
  assert.match(data.definitions.originating_article, /not proof of reading/);
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE_|never-return|private-payload/);
});
