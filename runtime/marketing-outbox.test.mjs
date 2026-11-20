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
    now: Date.parse('2026-11-20T02:01:00.000Z'),
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

test('transient failure is retried with backoff and an expired lease is recoverable', async (t) => {
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
