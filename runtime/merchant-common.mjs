// Shared server-side primitives. No provider credentials or request bodies are logged.
export class MerchantError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const IDENTIFIER = /^[a-z0-9][a-z0-9_-]{0,79}$/;
export const CONSENT_VERSION = 'merchant-support-v1';

export function field(value, label, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new MerchantError(400, 'INVALID_FIELD', `Check ${label}.`);
  }
  return value.trim();
}

export async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow', ...headers,
  } });
}

export async function readJson(request, max = 32768) {
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new MerchantError(415, 'JSON_REQUIRED', 'Send JSON.');
  if (Number(request.headers.get('content-length')) > max) throw new MerchantError(413, 'BODY_TOO_LARGE', 'The request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new MerchantError(400, 'INVALID_JSON', 'Send a JSON object.');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new MerchantError(413, 'BODY_TOO_LARGE', 'The request is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error();
    return parsed;
  } catch { throw new MerchantError(400, 'INVALID_JSON', 'Send a JSON object.'); }
}

export function httpsUrl(value, { originOnly = false } = {}) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (originOnly && (url.pathname !== '/' || url.search))) return null;
    return originOnly ? url.origin : url.href;
  } catch { return null; }
}

export function requirePrincipal(principal, scope) {
  if (!principal || typeof principal.issuer !== 'string' || typeof principal.subject !== 'string' ||
      !principal.subject || principal.subject.length > 512 || !Array.isArray(principal.scopes)) {
    throw new MerchantError(401, 'AUTH_REQUIRED', 'Connect your account before accessing customer support.');
  }
  if (!principal.scopes.includes(scope)) throw new MerchantError(403, 'SCOPE_REQUIRED', 'This action needs additional account permission.');
}

export async function principalHash(principal) {
  return digest(JSON.stringify([principal.issuer, principal.subject]));
}

export function errorResponse(error) {
  if (error instanceof MerchantError) return json({ error: { code: error.code, message: error.message } }, error.status);
  // Third-party error bodies can contain messages, contacts and credentials.
  return json({ error: { code: 'MERCHANT_SERVICE_UNAVAILABLE', message: 'Customer support is temporarily unavailable.' } }, 503);
}
