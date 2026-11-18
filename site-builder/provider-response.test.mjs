import test from 'node:test';
import assert from 'node:assert/strict';
import { readProviderJson } from './provider-response.mjs';

test('chunked JSON without Content-Length is canceled at the byte limit', async () => {
  let canceled = false;
  const response = new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(16).fill(32)); },
    cancel() { canceled = true; },
  }));
  await assert.rejects(() => readProviderJson(response, 32), /PROVIDER_RESPONSE_TOO_LARGE/);
  assert.equal(canceled, true);
});
