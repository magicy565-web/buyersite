import { createHash } from 'node:crypto';

export class MediaGenerationError extends Error {
  constructor(code, message) { super(message); this.name = 'MediaGenerationError'; this.code = code; }
}
const fail = (code, message) => { throw new MediaGenerationError(code, message); };
const PNG_HEADER = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function assertPng(bytes, limit = 12_000_000) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 50 || bytes.length > limit ||
      !bytes.subarray(0, 8).equals(PNG_HEADER)) {
    fail('MEDIA_GENERATION_INVALID_IMAGE', 'Expected a bounded PNG output');
  }
  return bytes;
}

export function makeEditorialPrompt({ title, pageType, direction }) {
  const clean = (value, max) => String(value || '').replace(/[\x00-\x1f<>]/g, ' ').slice(0, max);
  return [
    'Create ONE sophisticated original editorial illustration for an English-language B2B sourcing magazine.',
    'This is an artistic concept image, not a real product photo, factory photo, supplier evidence, specimen or certification.',
    'Aesthetic: ' + clean(direction, 70) + '. Section: ' + clean(pageType, 70) + '. Subject: ' + clean(title, 100) + '.',
    'Art direction: intentional composition, natural material texture, contemporary editorial photography-inspired collage, sophisticated restrained palette, generous negative space for headlines.',
    'Do not portray an identifiable real factory, branded product or real packaging; no trademarks, no labels, no diagrams with fabricated statistics, no text or logos.',
    'Image should be visually differentiated from other pages in the same magazine.',
  ].join(' ');
}

export async function generateEditorialPng({
  apiKey,
  prompt,
  model = 'gpt-image-2',
  fetchImpl = fetch,
  timeoutMs = 120_000,
}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('MEDIA_GENERATOR_NOT_CONFIGURED', 'AI image API key required');
  if (typeof prompt !== 'string' || !prompt || prompt.length > 1800) fail('MEDIA_GENERATION_PROMPT_INVALID', 'Bounded editorial prompt required');
  if (!/^gpt-image-2(?:\.[0-9]+)?(?:-[a-z0-9-]+)?$/.test(model)) fail('MEDIA_GENERATION_MODEL_INVALID', 'Use an explicitly approved GPT Image 2 model');
  let response;
  try {
    response = await fetchImpl('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, size: '1536x1024', quality: 'medium', n: 1 }),
    });
  } catch {
    fail('MEDIA_GENERATION_REQUEST_FAILED', 'Image provider request failed or timed out');
  }
  if (!response.ok) fail('MEDIA_GENERATION_REQUEST_FAILED', 'Image provider returned HTTP ' + response.status);
  let data;
  try { data = await response.json(); } catch { fail('MEDIA_GENERATION_RESPONSE_INVALID', 'Image provider returned invalid JSON'); }
  const encoded = data?.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || encoded.length > 16_100_000 || !/^[a-zA-Z0-9+/]+={0,2}$/.test(encoded)) {
    fail('MEDIA_GENERATION_RESPONSE_INVALID', 'Image provider response is missing bounded base64 bytes');
  }
  const imageBytes = assertPng(Buffer.from(encoded, 'base64'));
  return {
    bytes: imageBytes,
    kind: 'ai-generated',
    model,
    provider: 'openai-images',
    prompt_sha256: createHash('sha256').update(prompt).digest('hex'),
    sha256: createHash('sha256').update(imageBytes).digest('hex'),
    response_id: typeof data?.id === 'string' ? data.id.slice(0, 160) : null,
  };
}
