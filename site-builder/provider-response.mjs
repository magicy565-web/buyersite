// Bound response bytes while streaming, before allocating/decoding provider JSON.
// Error messages deliberately exclude provider bodies, prompts and credentials.
export async function readProviderJson(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
  }
  if (!response.body?.getReader) throw new Error('PROVIDER_RESPONSE_STREAM_REQUIRED');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}
