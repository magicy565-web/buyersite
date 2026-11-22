import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { enqueueMarketingEvent, dispatchMarketingOutbox, marketingOutboxStatus } from './marketing-outbox.mjs';

const config = { siteSlug: 'material-notes' };
const campaignId = 'cmp_12345678-1234-4234-8234-123456789abc';
const secret = 'test-only-mausbot-marketing-secret-0123456789';

function setup(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec(readFileSync(new URL('../drizzle/0003_marketing_outbox.sql', import.meta.url), 'utf8').replaceAll('--> statement-breakpoint', ''));
  const DB = {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...args) { values = args; return statement; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { return sqlite.prepare(sql).run(...values); },
      };
      return statement;
    },
  };
  return { sqlite, env: { DB } };
}

function event(overrides = {}) {
  return {
    eventId: 'buyersite:material-notes:inquiry:' + crypto.randomUUID(),
    campaignId, type: 'inquiry_submitted', occurredAt: '2026-11-20T02:00:00.000Z',
    landingUrl: 'https://buyersite.example/materials/wool', pagePath: '/enquiry',
    utm: { source: 'linkedin', medium: 'social', campaign: campaignId },
    inquiryId: crypto.randomUUID(),
    metadata: { destination: 'buyersite-editorial-inbox' },
    ...overrides,
  };
}

test('without credentials the durable outbox reports needs_connection and retains pending events', async (t) => {
  const { sqlite, env } = setup(t);
  await enqueueMarketingEvent(env, config, event());
  const status = await dispatchMarketingOutbox(env, config);
  assert.equal(status.status, 'needs_connection');
  assert.equal(sqlite.prepare('SELECT status FROM buyer_marketing_outbox').get().status, 'pending');
  assert.deepEqual(await marketingOutboxStatus(env, config), { connection: 'needs_connection', pending: 1, sending: 0, delivered: 0, dead: 0 });
});

test('attributed enquiry outbox sends HMAC-signed minimal payload and marks delivered only after MausBot acknowledgement', async (t) => {
  const { sqlite, env } = setup(t);
  const row = event();
  await enqueueMarketingEvent(env, config, row);
  const envWithConnection = { ...env, MAUSBOT_MARKETING_WEBHOOK_URL: 'https://maus.example/hooks/marketing/events/tenant-a', MAUSBOT_MARKETING_WEBHOOK_SECRET: secret };
  let calls = 0;
  const result = await dispatchMarketingOutbox(envWithConnection, config, {
    now: Date.now() + 1_000,
    fetchFn: async (url, init) => {
      calls++;
      assert.equal(url, envWithConnection.MAUSBOT_MARKETING_WEBHOOK_URL);
      assert.equal(init.redirect, 'error');
      const timestamp = new Headers(init.headers).get('X-Maus-Timestamp');
      const signature = new Headers(init.headers).get('X-Maus-Signature');
      assert.equal(signature, 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + init.body).digest('hex'));
      const payload = JSON.parse(init.body);
      assert.equal(payload.campaignId, campaignId);
      assert.equal(payload.inquiryId, row.inquiryId);
      assert.equal(payload.type, 'inquiry_submitted');
      assert.equal('email' in payload, false);
      assert.equal('material' in payload, false);
      assert.equal('application' in payload, false);
      return Response.json({ accepted: true, duplicate: false }, { status: 202 });
    },
  });
  assert.deepEqual(result, { status: 'configured', claimed: 1, delivered: 1, retried: 0, dead: 0 });
  assert.equal(calls, 1);
  assert.equal(sqlite.prepare('SELECT status FROM buyer_marketing_outbox').get().status, 'delivered');
  assert.equal((await marketingOutboxStatus(envWithConnection, config)).delivered, 1);
});

test('transient failure is retried with backoff', async (t) => {
  const { sqlite, env } = setup(t);
  await enqueueMarketingEvent(env, config, event());
  const connected = { ...env, MAUSBOT_MARKETING_WEBHOOK_URL: 'https://maus.example/marketing/events/tenant-a', MAUSBOT_MARKETING_WEBHOOK_SECRET: secret };
  const firstAt = Date.now() + 1_000;
  const failed = await dispatchMarketingOutbox(connected, config, { now: firstAt, fetchFn: async () => new Response('down', { status: 503 }) });
  assert.equal(failed.retried, 1);
  const pending = sqlite.prepare('SELECT status, attempts, next_attempt_at FROM buyer_marketing_outbox').get();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.attempts, 1);
  const retried = await dispatchMarketingOutbox(connected, config, { now: pending.next_attempt_at + 1, fetchFn: async () => Response.json({ accepted: true }, { status: 202 }) });
  assert.equal(retried.delivered, 1);
  assert.equal(sqlite.prepare('SELECT status, attempts FROM buyer_marketing_outbox').get().status, 'delivered');
});

test('invalid or non-canonical Campaign ids are not attributed and cannot trigger an outbound event', async (t) => {
  const { sqlite, env } = setup(t);
  assert.equal(await enqueueMarketingEvent(env, config, event({ campaignId: 'random-campaign', utm: { source: 'linkedin', campaign: 'random-campaign' } })), false);
  assert.equal(await enqueueMarketingEvent(env, config, event({ utm: { source: 'linkedin', medium: 'social', campaign: campaignId, private: 'x' } })), false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS count FROM buyer_marketing_outbox').get().count, 0);
});

test('shared SQLite D1 isolates pending and expired-lease claims by siteSlug', async (t) => {
  const { sqlite, env } = setup(t);
  const siteA = { siteSlug: 'site-a' };
  const siteB = { siteSlug: 'site-b' };
  const bPending = event({ eventId: 'buyersite:site-b:inquiry:' + crypto.randomUUID() });
  const bExpired = event({ eventId: 'buyersite:site-b:inquiry:' + crypto.randomUUID() });
  const aPending = event({ eventId: 'buyersite:site-a:inquiry:' + crypto.randomUUID() });
  // Insert the other edition first to detect a global queue scan.
  await enqueueMarketingEvent(env, siteB, bPending);
  await enqueueMarketingEvent(env, siteB, bExpired);
  await enqueueMarketingEvent(env, siteA, aPending);
  const base = Date.now() + 1_000;
  sqlite.prepare("UPDATE buyer_marketing_outbox SET status='sending', attempts=1, lease_until=? WHERE site_slug='site-b' AND event_id=?")
    .run(base - 1, bExpired.eventId);
  const connected = { ...env, MAUSBOT_MARKETING_WEBHOOK_URL: 'https://maus.example/marketing/events/site-a', MAUSBOT_MARKETING_WEBHOOK_SECRET: secret };
  let callsA = 0;
  const aResult = await dispatchMarketingOutbox(connected, siteA, {
    now: base,
    fetchFn: async (url, init) => {
      callsA++;
      assert.equal(url, connected.MAUSBOT_MARKETING_WEBHOOK_URL);
      assert.equal(JSON.parse(init.body).eventId, aPending.eventId);
      return Response.json({ accepted: true }, { status: 202 });
    },
  });
  assert.equal(aResult.claimed, 1);
  assert.equal(aResult.delivered, 1);
  assert.equal(callsA, 1);
  assert.equal(sqlite.prepare('SELECT status FROM buyer_marketing_outbox WHERE event_id=?').get(bPending.eventId).status, 'pending');
  assert.equal(sqlite.prepare('SELECT status FROM buyer_marketing_outbox WHERE event_id=?').get(bExpired.eventId).status, 'sending');
  assert.equal((await marketingOutboxStatus(connected, siteA)).delivered, 1);
  assert.equal((await marketingOutboxStatus(connected, siteB)).delivered, 0);

  const bEvents = new Set();
  const connectedB = { ...connected, MAUSBOT_MARKETING_WEBHOOK_URL: 'https://maus.example/marketing/events/site-b' };
  const bResult = await dispatchMarketingOutbox(connectedB, siteB, {
    now: base,
    fetchFn: async (url, init) => {
      assert.equal(url, connectedB.MAUSBOT_MARKETING_WEBHOOK_URL);
      bEvents.add(JSON.parse(init.body).eventId);
      return Response.json({ accepted: true }, { status: 202 });
    },
  });
  assert.equal(bResult.delivered, 2);
  assert.deepEqual(bEvents, new Set([bPending.eventId, bExpired.eventId]));
  assert.equal(sqlite.prepare('SELECT attempts FROM buyer_marketing_outbox WHERE event_id=?').get(bExpired.eventId).attempts, 2);
  assert.equal((await marketingOutboxStatus(connectedB, siteB)).delivered, 2);

  const noScope = await dispatchMarketingOutbox(connected, {}, {
    fetchFn: async () => { assert.fail('missing siteSlug must not send'); },
  });
  assert.equal(noScope.status, 'unavailable');
  assert.equal(noScope.claimed, 0);
});

test('reclaimed SQLite lease fences stale completions and preserves new owner acknowledgement', async (t) => {
  const { sqlite, env } = setup(t);
  await enqueueMarketingEvent(env, config, event());
  const connected = { ...env, MAUSBOT_MARKETING_WEBHOOK_URL: 'https://maus.example/marketing/events/tenant-a', MAUSBOT_MARKETING_WEBHOOK_SECRET: secret };
  let startedOld, releaseOld;
  const oldStarted = new Promise((resolve) => { startedOld = resolve; });
  const oldReleased = new Promise((resolve) => { releaseOld = resolve; });
  const base = Date.now() + 1_000;
  const oldDispatch = dispatchMarketingOutbox(connected, config, {
    now: base,
    fetchFn: async () => {
      startedOld();
      await oldReleased;
      return new Response('permanent failure from old owner', { status: 400 });
    },
  });
  await oldStarted;
  assert.deepEqual(sqlite.prepare('SELECT status, attempts FROM buyer_marketing_outbox').get(), { status: 'sending', attempts: 1 });
  const newer = await dispatchMarketingOutbox(connected, config, {
    now: base + 60_001,
    fetchFn: async () => Response.json({ accepted: true }, { status: 202 }),
  });
  assert.equal(newer.claimed, 1);
  assert.equal(newer.delivered, 1);
  releaseOld();
  const stale = await oldDispatch;
  assert.equal(stale.claimed, 1);
  assert.equal(stale.dead, 0);
  assert.equal(stale.retried, 0);
  const persisted = sqlite.prepare('SELECT status, attempts, delivered_at, last_error FROM buyer_marketing_outbox').get();
  assert.equal(persisted.status, 'delivered');
  assert.equal(persisted.attempts, 2);
  assert.equal(persisted.last_error, null);
  assert.ok(persisted.delivered_at);
});

test('sequential delivery takes a fresh lease for each SQLite row', async (t) => {
  const { sqlite, env } = setup(t);
  await enqueueMarketingEvent(env, config, event());
  await enqueueMarketingEvent(env, config, event());
  const connected = { ...env, MAUSBOT_MARKETING_WEBHOOK_URL: 'https://maus.example/marketing/events/tenant-a', MAUSBOT_MARKETING_WEBHOOK_SECRET: secret };
  const leaseTimes = [];
  const result = await dispatchMarketingOutbox(connected, config, {
    now: Date.now() + 1_000, limit: 2,
    fetchFn: async (_url, init) => {
      const eventId = JSON.parse(init.body).eventId;
      leaseTimes.push(sqlite.prepare('SELECT lease_until FROM buyer_marketing_outbox WHERE event_id=?').get(eventId).lease_until);
      if (leaseTimes.length === 1) await new Promise((resolve) => setTimeout(resolve, 20));
      return Response.json({ accepted: true }, { status: 202 });
    },
  });
  assert.equal(result.claimed, 2);
  assert.equal(result.delivered, 2);
  assert.ok(leaseTimes[1] > leaseTimes[0], 'later rows must not inherit an earlier claim time');
});
