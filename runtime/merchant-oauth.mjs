// OAuth resource-server verification only. The merchant's existing OAuth provider
// owns login, PKCE, consent, refresh, and token issuance. Never accept a shared API
// token or a caller-provided subject as an authenticated customer identity.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_TOKEN_BYTES = 16_384;
const MAX_JWKS_BYTES = 65_536;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/;

export class MerchantOAuthError extends Error {
  constructor(code = 'invalid_token', status = 401) {
    super(code === 'insufficient_scope' ? 'The linked account needs additional permission.' : 'Link a valid customer account to continue.');
    this.name = 'MerchantOAuthError';
    this.code = code;
    this.status = status;
  }
}

function httpsUrl(value, name) {
  if (typeof value !== 'string' || value.length > 2_048) throw new Error(`Invalid OAuth ${name} configuration.`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`Invalid OAuth ${name} configuration.`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`Invalid OAuth ${name} configuration.`);
  }
  return value;
}

function bytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new MerchantOAuthError();
  try {
    const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
    const decoded = Uint8Array.from(atob(normalized), (character) => character.charCodeAt(0));
    // Reject noncanonical base64url encodings, including nonzero padding bits.
    const canonical = btoa(String.fromCharCode(...decoded)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    if (canonical !== value) throw new Error();
    return decoded;
  } catch { throw new MerchantOAuthError(); }
}

function objectSegment(value) {
  try {
    const parsed = JSON.parse(decoder.decode(bytes(value)));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch { throw new MerchantOAuthError(); }
}

export function parseOAuthScopes(value) {
  if (typeof value !== 'string' || value.length > 4_096) throw new MerchantOAuthError();
  if (!value) return [];
  const scopes = value.split(' ');
  if (scopes.length > 64 || scopes.some((scope) => !SCOPE.test(scope))) throw new MerchantOAuthError();
  return [...new Set(scopes)];
}

async function boundedJwks(response) {
  const declared = Number(response.headers.get('content-length'));
  const mediaType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!response.ok || !['application/json', 'application/jwk-set+json'].includes(mediaType) ||
      Number.isFinite(declared) && declared > MAX_JWKS_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_JWKS_BYTES) throw new Error();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const result = JSON.parse(decoder.decode(body));
  if (!result || !Array.isArray(result.keys) || result.keys.length < 1 || result.keys.length > 32) throw new Error();
  return result.keys;
}

/**
 * Supported access-token profile: signed RS256 JWT with iss, aud, sub, exp, iat
 * and a space-delimited OAuth scope. JWKS is fetched only from the operator's
 * configured HTTPS URI. User-controlled jku/x5u and token-provided keys are ignored
 * by rejecting those headers. The verifier never performs discovery from a token.
 */
export function createMerchantOAuthVerifier({
  issuer, audience, jwksUri, fetchFn = fetch, now = Date.now,
  cacheTtlMs = 300_000, maxTokenLifetimeSeconds = 3_600,
} = {}) {
  httpsUrl(issuer, 'issuer');
  httpsUrl(audience, 'audience');
  httpsUrl(jwksUri, 'JWKS URI');
  if (typeof fetchFn !== 'function' || typeof now !== 'function' ||
      !Number.isInteger(cacheTtlMs) || cacheTtlMs < 0 || cacheTtlMs > 300_000 ||
      !Number.isInteger(maxTokenLifetimeSeconds) || maxTokenLifetimeSeconds < 60 || maxTokenLifetimeSeconds > 86_400) {
    throw new Error('Invalid OAuth verification configuration.');
  }
  let cached = null;
  let expiresAt = 0;
  let loading = null;
  async function keys() {
    if (cached && now() < expiresAt) return cached;
    if (!loading) {
      loading = (async () => {
        const response = await fetchFn(jwksUri, {
          method: 'GET', headers: { Accept: 'application/jwk-set+json, application/json' },
          redirect: 'error', signal: AbortSignal.timeout(5_000),
        });
        const result = await boundedJwks(response);
        cached = result;
        expiresAt = now() + cacheTtlMs;
        return result;
      })().finally(() => { loading = null; });
    }
    return loading;
  }
  return async function verifyAccessToken(token, requiredScopes = []) {
    try {
      if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES || token.length < 32 ||
          !Array.isArray(requiredScopes) || requiredScopes.some((scope) => typeof scope !== 'string' || !SCOPE.test(scope))) throw new MerchantOAuthError();
      const segments = token.split('.');
      if (segments.length !== 3) throw new MerchantOAuthError();
      const header = objectSegment(segments[0]);
      const payload = objectSegment(segments[1]);
      if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(header.kid) ||
          (header.typ !== undefined && !['JWT', 'at+jwt'].includes(header.typ)) ||
          ['crit', 'jku', 'x5u', 'jwk', 'b64'].some((field) => Object.hasOwn(header, field))) throw new MerchantOAuthError();
      const seconds = Math.floor(now() / 1_000);
      const audiences = typeof payload.aud === 'string' ? [payload.aud] : payload.aud;
      if (payload.iss !== issuer || !Array.isArray(audiences) || !audiences.length || audiences.length > 10 ||
          audiences.some((value) => typeof value !== 'string') || !audiences.includes(audience) ||
          typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 200 || /[\u0000-\u001f\u007f]/.test(payload.sub) ||
          !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat) ||
          payload.exp <= seconds || payload.iat > seconds || payload.iat < 0 || payload.exp <= payload.iat ||
          payload.exp - payload.iat > maxTokenLifetimeSeconds ||
          (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf < 0 || payload.nbf > seconds || payload.nbf >= payload.exp))) throw new MerchantOAuthError();
      const scopes = parseOAuthScopes(payload.scope ?? '');
      const candidates = (await keys()).filter((key) => key && key.kid === header.kid);
      if (candidates.length !== 1) throw new MerchantOAuthError();
      const jwk = candidates[0];
      if (jwk.kty !== 'RSA' || (jwk.alg !== undefined && jwk.alg !== 'RS256') ||
          (jwk.use !== undefined && jwk.use !== 'sig') ||
          (jwk.key_ops !== undefined && (!Array.isArray(jwk.key_ops) || jwk.key_ops.length !== 1 || jwk.key_ops[0] !== 'verify')) ||
          ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'].some((field) => Object.hasOwn(jwk, field)) ||
          bytes(jwk.n).length < 256 || bytes(jwk.n).length > 1_024 || bytes(jwk.e).length > 8) throw new MerchantOAuthError();
      const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      if (key.algorithm.modulusLength < 2_048 || key.algorithm.modulusLength > 8_192) throw new MerchantOAuthError();
      const verified = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, bytes(segments[2]), encoder.encode(`${segments[0]}.${segments[1]}`));
      if (!verified) throw new MerchantOAuthError();
      // A key fetch can outlive a short-lived token. Recheck time at the point
      // where a principal would be issued, not only before the network request.
      const verifiedAt = Math.floor(now() / 1_000);
      if (payload.exp <= verifiedAt || payload.iat > verifiedAt || (payload.nbf !== undefined && payload.nbf > verifiedAt)) throw new MerchantOAuthError();
      if (requiredScopes.some((scope) => !scopes.includes(scope))) throw new MerchantOAuthError('insufficient_scope', 403);
      return Object.freeze({ issuer, subject: payload.sub, scopes: Object.freeze(scopes) });
    } catch (error) {
      if (error instanceof MerchantOAuthError) throw error;
      // Signing-key outages also fail closed. Never echo provider bodies or tokens.
      throw new MerchantOAuthError();
    }
  };
}
