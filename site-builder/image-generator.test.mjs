import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { generateEditorialPng, makeEditorialPrompt, MediaGenerationError } from './image-generator.mjs';

test('image adapter constructs the documented request and validates a mocked PNG response', async () => {
  const png = await sharp({ create: { width: 1024, height: 768, channels: 3, background: '#957b76' } }).png().toBuffer();
  const prompt = makeEditorialPrompt({ title: 'Cotton textile selection', pageType: 'product-editorial', direction: 'Atelier' });
  assert.match(prompt, /not a real product photo/i);
  let requested = 0;
  const result = await generateEditorialPng({
    apiKey: 'synthetic-secret', prompt,
    fetchImpl: async (url, init) => {
      requested++;
      assert.equal(url, 'https://api.openai.com/v1/images/generations');
      assert.match(init.headers.authorization, /^Bearer synthetic-secret$/);
      const payload = JSON.parse(init.body);
      assert.equal(payload.model, 'gpt-image-2');
      assert.equal(payload.size, '1536x1024');
      assert.equal(payload.n, 1);
      assert.equal(payload.output_format, 'png');
      return Response.json({ data: [{ b64_json: png.toString('base64') }] });
    },
  });
  assert.equal(requested, 1);
  assert.deepEqual(result.bytes, png);
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.match(result.prompt_sha256, /^[a-f0-9]{64}$/);
});

test('provider payload limits are enforced before parsing JSON', async () => {
  let canceled = false;
  await assert.rejects(() => generateEditorialPng({
    apiKey: 'synthetic-test', prompt: 'Editorial concept',
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() { canceled = true; },
    }), { headers: { 'content-length': '99999999' } }),
  }), (error) => error.code === 'MEDIA_GENERATION_RESPONSE_INVALID');
  assert.equal(canceled, true);
});

test('no key, invalid model, and provider failure cannot silently produce an approved image', async () => {
  await assert.rejects(() => generateEditorialPng({ apiKey: '', prompt: 'valid prompt' }), MediaGenerationError);
  await assert.rejects(() => generateEditorialPng({ apiKey: 'test', prompt: 'valid', model: 'untrusted-image-provider' }), MediaGenerationError);
  await assert.rejects(() => generateEditorialPng({
    apiKey: 'test', prompt: 'valid', fetchImpl: async () => ({ ok: false, status: 403 }),
  }), MediaGenerationError);
});
