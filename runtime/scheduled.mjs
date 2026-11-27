/** Run each durable queue independently. A failed queue must not starve the other. */
export function createScheduledHandler(config, { drainMerchant, dispatchMarketing }) {
  async function run(name, task) {
    try {
      const result = await task();
      if (result?.status === 'worker_failed') console.error(`BuyerSite scheduled ${name} queue failed`);
      return result;
    } catch {
      // Do not log exception messages: provider or database errors may contain secrets.
      console.error(`BuyerSite scheduled ${name} queue failed`);
      return { status: 'worker_failed' };
    }
  }
  return async function scheduled(_event, env, ctx) {
    const work = Promise.all([
      run('merchant', () => drainMerchant(env)),
      config.publication === 'public'
        ? run('marketing', () => dispatchMarketing(env, config))
        : Promise.resolve({ status: 'disabled' }),
    ]).then(([merchant, marketing]) => ({ merchant, marketing }));
    if (typeof ctx?.waitUntil === 'function') ctx.waitUntil(work);
    return await work;
  };
}
