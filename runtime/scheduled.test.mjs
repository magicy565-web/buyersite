import test from 'node:test';
import assert from 'node:assert/strict';
import { createScheduledHandler } from './scheduled.mjs';

const config = { siteSlug: 'edition-a', publication: 'public' };
const env = { DB: {} };
const merchant = { status: 'configured', processed: 1 };
const marketing = { status: 'configured', claimed: 1, delivered: 1, retried: 0, dead: 0 };

test('one scheduled event awaits both queues and registers the combined work', async () => {
  const calls = [];
  let finishMerchant;
  const scheduled = createScheduledHandler(config, {
    drainMerchant: async value => {
      assert.equal(value, env);
      calls.push('merchant');
      await new Promise(resolve => { finishMerchant = resolve; });
      return merchant;
    },
    dispatchMarketing: async (value, edition) => {
      assert.equal(value, env);
      assert.equal(edition, config);
      calls.push('marketing');
      return marketing;
    },
  });
  const registered = [];
  const pending = scheduled({}, env, { waitUntil: work => registered.push(work) });
  assert.deepEqual(calls, ['merchant', 'marketing']);
  assert.equal(registered.length, 1);
  finishMerchant();
  assert.deepEqual(await pending, { merchant, marketing });
  assert.deepEqual(await registered[0], { merchant, marketing });
});

test('a synchronous merchant failure cannot stop marketing', async () => {
  const scheduled = createScheduledHandler(config, {
    drainMerchant: () => { throw Error('private provider details'); },
    dispatchMarketing: async () => marketing,
  });
  assert.deepEqual(await scheduled({}, env), { merchant: { status: 'worker_failed' }, marketing });
});

test('an asynchronous marketing failure cannot stop merchant processing', async () => {
  const scheduled = createScheduledHandler(config, {
    drainMerchant: async () => merchant,
    dispatchMarketing: async () => { throw Error('private database details'); },
  });
  assert.deepEqual(await scheduled({}, env, {}), { merchant, marketing: { status: 'worker_failed' } });
});

test('disabled merchant support and unconnected marketing remain independent states', async () => {
  const scheduled = createScheduledHandler(config, {
    drainMerchant: async () => ({ status: 'disabled' }),
    dispatchMarketing: async () => ({ status: 'needs_connection' }),
  });
  assert.deepEqual(await scheduled({}, env), {
    merchant: { status: 'disabled' }, marketing: { status: 'needs_connection' },
  });
});

test('private or unspecified publication cannot dispatch marketing externally', async () => {
  for (const publication of ['private', undefined]) {
    const scheduled = createScheduledHandler({ ...config, publication }, {
      drainMerchant: async () => ({ status: 'disabled' }),
      dispatchMarketing: () => assert.fail('must not dispatch marketing'),
    });
    assert.deepEqual(await scheduled({}, env), {
      merchant: { status: 'disabled' }, marketing: { status: 'disabled' },
    });
  }
});
