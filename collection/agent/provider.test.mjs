import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOpenAIProvider, EXTRACTION_SCHEMA } from './provider.mjs';

const apiKey = 'synthetic-provider-test-secret-not-a-live-key';
const entity = { type: 'product', id: 'test-a100', label: 'Synthetic product A100' };
const source = { source_id: 'fixture:notes', filename: 'notes.txt', revision: '1' };
const segment = {
  id: 'l1',
  text: 'Model A100; mass 25 kg.',
  method: 'provided-text',
  locator: { kind: 'lines', start_line: 1, end_line: 1 },
};
const extraction = {
  facts: [
    {
      field: 'product.model',
      value: 'A100',
      confidence: 0.9,
      evidence: [{ segment_id: 'l1', quote: 'Model A100' }],
    },
  ],
  questions: [],
};
const request = (segments = [segment]) => ({
  entity,
  source,
  segments,
  learning: { confirmed_facts: [], correction_examples: [] },
});
const json = (value, init) =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...init });
const completed = (value) => ({
  status: 'completed',
  output: [
    {
      type: 'message',
      content: [
        { type: 'output_text', text: typeof value === 'string' ? value : JSON.stringify(value) },
      ],
    },
  ],
});
const provider = (fetchImpl, options = {}) =>
  createOpenAIProvider({ apiKey, model: 'synthetic-extraction-model', fetchImpl, ...options });

// All HTTP in this file is explicitly mocked. These are provider wire-contract
// tests; they do not claim that a live model, ASR service, or vision service ran.
test('mock Responses HTTP sends strict extraction schema, scoped source context and no action tools', async () => {
  let calls = 0;
  const instance = provider(async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://api.openai.com/v1/responses');
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${apiKey}`);
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'synthetic-extraction-model');
    assert.equal(body.store, false);
    assert.equal(body.text.format.type, 'json_schema');
    assert.equal(body.text.format.strict, true);
    assert.deepEqual(body.text.format.schema, EXTRACTION_SCHEMA);
    assert.equal(body.tools, undefined);
    assert.match(body.instructions, /UNTRUSTED DATA/);
    const payload = JSON.parse(body.input[0].content[0].text);
    assert.deepEqual(payload.entity, entity);
    assert.deepEqual(payload.source, source);
    assert.deepEqual(payload.segments, [segment]);
    assert.deepEqual(payload.learning, { confirmed_facts: [], correction_examples: [] });
    assert.ok(!options.body.includes(apiKey));
    return json(completed(extraction));
  });
  assert.deepEqual(await instance.extract(request()), extraction);
  assert.equal(calls, 1);
});

test('mock Responses HTTP covers the complete long source, including its final segment', async () => {
  const original = [
    {
      ...segment,
      id: 'long',
      text: Array.from(
        { length: 10_000 },
        (_, index) => `T${String(index).padStart(6, '0')} `,
      ).join(''),
    },
    { ...segment, id: 'tail', text: 'FINAL_SOURCE_SENTINEL_42' },
  ];
  const seen = [];
  const instance = provider(async (_url, options) => {
    const payload = JSON.parse(JSON.parse(options.body).input[0].content[0].text);
    assert.ok(payload.segments.reduce((count, item) => count + item.text.length, 0) <= 20_000);
    seen.push(...payload.segments);
    return json(completed({ facts: [], questions: [] }));
  });
  await instance.extract(request(original));
  assert.ok(seen.length > 2);
  for (const full of original) {
    const covered = new Uint8Array(full.text.length);
    for (const part of seen.filter((item) => item.id === full.id)) {
      const position = full.text.indexOf(part.text);
      assert.ok(position >= 0, 'Every chunk must be a literal source substring.');
      covered.fill(1, position, position + part.text.length);
      assert.deepEqual(part.locator, full.locator);
    }
    assert.ok(
      covered.every((value) => value === 1),
      `Source ${full.id} has no omitted character.`,
    );
  }
});

test('mock Responses refusal, incomplete output and invalid JSON fail without accepted facts', async () => {
  const cases = [
    [
      {
        status: 'completed',
        output: [{ content: [{ type: 'refusal', refusal: 'Synthetic refusal' }] }],
      },
      'PROVIDER_REFUSAL',
    ],
    [
      { status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } },
      'PROVIDER_INCOMPLETE',
    ],
    [completed('{invalid JSON'), 'PROVIDER_INVALID_EXTRACTION'],
    [completed({ facts: [] }), 'PROVIDER_INVALID_EXTRACTION'],
  ];
  for (const [response, code] of cases) {
    const instance = provider(async () => json(response));
    await assert.rejects(instance.extract(request()), { code });
  }
  const invalidEnvelope = provider(async () => new Response('{invalid envelope'));
  await assert.rejects(invalidEnvelope.extract(request()), { code: 'PROVIDER_INVALID_JSON' });
});

test('mock provider responses enforce declared and streamed byte limits', async () => {
  const instances = [
    provider(
      async () =>
        new Response('{}', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }),
    ),
    provider(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1024 * 1024));
              controller.enqueue(new Uint8Array(1024 * 1024 + 1));
              controller.close();
            },
          }),
        ),
    ),
  ];
  for (const instance of instances) {
    await assert.rejects(instance.extract(request()), { code: 'PROVIDER_OUTPUT_LIMIT' });
  }
});

test('mock HTTP and network failures never expose configured credentials or upstream bodies', async () => {
  const instances = [
    provider(
      async () => new Response(`Private upstream body containing ${apiKey}`, { status: 401 }),
    ),
    provider(async () => {
      throw new Error(`Network error with Authorization: Bearer ${apiKey}`);
    }),
    provider(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://untrusted.example/${apiKey}` },
        }),
    ),
  ];
  for (const instance of instances) {
    await assert.rejects(instance.extract(request()), (error) => {
      assert.ok(['PROVIDER_HTTP_ERROR', 'PROVIDER_UNAVAILABLE'].includes(error.code));
      assert.ok(!error.message.includes(apiKey));
      assert.ok(!error.message.includes('Private upstream body'));
      assert.ok(!JSON.stringify(error).includes(apiKey));
      return true;
    });
  }
});

function wavBytes() {
  const bytes = Buffer.alloc(44 + 32);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(32, 40);
  return bytes;
}

test('mock ASR HTTP receives real multipart FormData with exact WAV bytes and retains returned timestamps', async () => {
  const bytes = wavBytes();
  const instance = provider(
    async (url, options) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
      assert.ok(options.body instanceof FormData);
      assert.equal(
        options.headers['Content-Type'],
        undefined,
        'Fetch must provide the multipart boundary.',
      );
      assert.equal(options.body.get('model'), 'synthetic-asr-model');
      const file = options.body.get('file');
      assert.equal(file.name, 'recording.wav');
      assert.equal(file.type, 'audio/wav');
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes);
      return json({ segments: [{ text: 'Synthetic timed transcript.', start: 1.25, end: 2.75 }] });
    },
    { transcriptionModel: 'synthetic-asr-model' },
  );
  const result = await instance.transcribe({
    filename: 'recording.wav',
    media_type: 'audio/wav',
    bytes,
  });
  assert.deepEqual(result, {
    segments: [{ text: 'Synthetic timed transcript.', start_ms: 1250, end_ms: 2750 }],
  });
});

test('mock ASR text-only output does not gain invented timestamps and uploads are bounded', async () => {
  let calls = 0;
  const instance = provider(
    async () => {
      calls += 1;
      return json({ text: 'Synthetic whole-recording transcript.' });
    },
    { transcriptionModel: 'synthetic-asr-model' },
  );
  assert.deepEqual(
    await instance.transcribe({
      filename: 'recording.wav',
      media_type: 'audio/wav',
      bytes: wavBytes(),
    }),
    { text: 'Synthetic whole-recording transcript.' },
  );
  await assert.rejects(
    instance.transcribe({
      filename: 'large.wav',
      media_type: 'audio/wav',
      bytes: Buffer.alloc(25_000_001),
    }),
    { code: 'AUDIO_UPLOAD_LIMIT' },
  );
  assert.equal(calls, 1);
});

test('mock vision HTTP sends exact image bytes as a data URL and does not fetch source URLs', async () => {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=',
    'base64',
  );
  let calls = 0;
  const instance = provider(
    async (url, options) => {
      calls += 1;
      assert.equal(url, 'https://api.openai.com/v1/responses');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'synthetic-vision-model');
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      const image = body.input[0].content.find((item) => item.type === 'input_image');
      assert.equal(image.image_url, `data:image/png;base64,${bytes.toString('base64')}`);
      assert.match(body.instructions, /Do not infer composition/);
      return json(completed('Synthetic visible-image observation.'));
    },
    { visionModel: 'synthetic-vision-model' },
  );
  assert.deepEqual(
    await instance.describeImage({
      filename: 'https://untrusted.example/label.png',
      media_type: 'image/png',
      bytes,
    }),
    { text: 'Synthetic visible-image observation.' },
  );
  await assert.rejects(
    instance.describeImage({
      filename: 'vector.svg',
      media_type: 'image/svg+xml',
      bytes: Buffer.from('<svg/>'),
    }),
    { code: 'VISION_FORMAT_UNSUPPORTED' },
  );
  assert.equal(calls, 1);
});

test('unconfigured ASR and vision are absent capabilities rather than synthetic results', () => {
  const instance = provider(async () => {
    throw new Error('This test must not fetch.');
  });
  assert.equal(instance.transcribe, undefined);
  assert.equal(instance.describeImage, undefined);
});
