import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { CollectionError } from './errors.mjs';
import { captureWebsitePage, siteUrl, sameHost } from './website.mjs';

export { CollectionError, captureWebsitePage };
export const COLLECTION_SCHEMA = 'buyersite-collection-v1';
export const LIMITS = Object.freeze({ websites: 5, documents: 8, documentBytes: 2_000_000, totalDocumentBytes: 8_000_000, websiteBytes: 900_000 });
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw new CollectionError(code, message); };
const string = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) && value.trim() === value;
const types = new Set(['operator-upload', 'enterprise-export', 'dataset-export']);
const plainText = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);
const sourceId = (enterprise, kind, key) => digest(JSON.stringify([enterprise, kind, key]));
const snapshotKeys = ['url', 'title', 'body_text', 'content_sha256', 'captured_at'];

function checkedWebsite(snapshot, requestedUrl) {
  if (!snapshot || !string(snapshot.title, 250) || typeof snapshot.body_text !== 'string' ||
      snapshot.body_text.trim().length < 40 || snapshot.body_text.length > 30_000 ||
      digest(snapshot.body_text) !== snapshot.content_sha256 ||
      typeof snapshot.captured_at !== 'string' || !Number.isFinite(Date.parse(snapshot.captured_at))) {
    fail('INVALID_CAPTURE', 'Website capture is missing its bounded text or provenance');
  }
  if (!sameHost(siteUrl(requestedUrl), siteUrl(snapshot.url))) fail('CROSS_DOMAIN_SOURCE', 'Capture returned a different domain');
  if (typeof snapshot.raw_content_base64 !== 'string' || snapshot.raw_content_base64.length > Math.ceil(LIMITS.websiteBytes / 3) * 4 ||
      typeof snapshot.raw_content_type !== 'string' || !/^text\/html(?:\s*;|$)/i.test(snapshot.raw_content_type)) {
    fail('INVALID_CAPTURE', 'Original website HTML is missing or oversized');
  }
  const bytes = Buffer.from(snapshot.raw_content_base64, 'base64');
  if (bytes.length > LIMITS.websiteBytes || bytes.toString('base64') !== snapshot.raw_content_base64 ||
      digest(bytes) !== snapshot.raw_content_sha256) fail('SOURCE_HASH_MISMATCH', 'Original website bytes do not match the recorded hash');
  return {
    ...Object.fromEntries(snapshotKeys.map((key) => [key, snapshot[key]])),
    raw_content_type: snapshot.raw_content_type,
    raw_content_sha256: snapshot.raw_content_sha256,
    raw_content_base64: snapshot.raw_content_base64,
    byte_length: bytes.length,
  };
}

function validateRequest(input) {
  if (!input || input.authorized !== true || !string(input.enterprise_id, 128))
    fail('COLLECTION_AUTHORIZATION_REQUIRED', 'Pass an authorized, server-owned enterprise collection request');
  const websites = input.website_urls ?? [];
  const documents = input.documents ?? [];
  if (!Array.isArray(websites) || websites.length > LIMITS.websites ||
      !Array.isArray(documents) || documents.length > LIMITS.documents || websites.length + documents.length === 0)
    fail('INVALID_COLLECTION_SCOPE', 'Provide one to five website URLs and/or one to eight documents');
  const urls = websites.map((url) => {
    if (!string(url, 2048)) fail('INVALID_URL', 'Website URL must be a bounded string');
    return siteUrl(url).href;
  });
  if (new Set(urls).size !== urls.length) fail('DUPLICATE_SOURCE', 'Duplicate website URL');
  let total = 0;
  const names = new Set();
  const files = documents.map((doc) => {
    if (!doc || !string(doc.name, 200) || /[\/\\]/.test(doc.name) || doc.name === '.' || doc.name === '..' ||
        !string(doc.media_type, 100) || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(doc.media_type) ||
        !types.has(doc.source_kind) || !Buffer.isBuffer(doc.bytes) || doc.bytes.length === 0 ||
        doc.bytes.length > LIMITS.documentBytes || (doc.source_ref != null && !string(doc.source_ref, 2048)))
      fail('INVALID_DOCUMENT', 'Provide a bounded named original file, declared media type, source kind and Buffer bytes');
    const key = JSON.stringify([doc.source_kind, doc.source_ref ?? null, doc.name]);
    if (names.has(key)) fail('DUPLICATE_SOURCE', 'Duplicate document source');
    names.add(key);
    total += doc.bytes.length;
    if (total > LIMITS.totalDocumentBytes) fail('COLLECTION_TOO_LARGE', 'Document batch exceeds byte limit');
    return { name: doc.name, media_type: doc.media_type.toLowerCase(), source_kind: doc.source_kind,
      source_ref: doc.source_ref ?? null, bytes: Buffer.from(doc.bytes), key };
  });
  return { enterprise: input.enterprise_id, urls, files };
}

function collectDocument(doc) {
  let body_text = null;
  if (plainText.has(doc.media_type)) {
    try {
      body_text = new TextDecoder('utf-8', { fatal: true }).decode(doc.bytes);
      if (doc.media_type === 'application/json') JSON.parse(body_text);
    } catch { fail('INVALID_DOCUMENT_TEXT', 'Declared UTF-8 text or JSON is malformed'); }
  }
  return {
    name: doc.name, media_type: doc.media_type, media_type_verification: 'declared',
    source_kind: doc.source_kind, source_ref: doc.source_ref,
    byte_length: doc.bytes.length, content_sha256: digest(doc.bytes),
    original_base64: doc.bytes.toString('base64'),
    extraction_status: body_text === null ? 'raw-only' : 'text-available', body_text,
    captured_at: new Date().toISOString(),
  };
}

const knownErrors = new Set(['INVALID_URL', 'PRIVATE_ADDRESS', 'DNS_FAILED', 'SOURCE_TOO_LARGE',
  'SOURCE_TIMEOUT', 'SOURCE_FETCH_FAILED', 'ROBOTS_BLOCKED', 'CROSS_DOMAIN_REDIRECT',
  'EMPTY_SOURCE', 'TOO_MANY_REDIRECTS', 'INVALID_CAPTURE', 'CROSS_DOMAIN_SOURCE',
  'SOURCE_HASH_MISMATCH', 'INVALID_DOCUMENT_TEXT', 'DUPLICATE_SOURCE']);
const errorCode = (error) => knownErrors.has(error?.code) ? error.code : 'COLLECTION_FAILED';

/**
 * Trusted server/operator API only. The authorized flag records upstream permission;
 * it is not authentication. Never expose as a public URL fetch or upload handler.
 * Captures are unverified and private even if a source URL is public.
 */
export async function collectSources(input, { capture = captureWebsitePage } = {}) {
  const { enterprise, urls, files } = validateRequest(input);
  const records = [];
  const capturedUrls = new Set();
  for (const url of urls) {
    const base = { source_id: sourceId(enterprise, 'website', url), kind: 'website', requested_url: url };
    try {
      const snapshot = checkedWebsite(await capture(url), url);
      if (capturedUrls.has(snapshot.url)) fail('DUPLICATE_SOURCE', 'Redirect resolved to an already captured URL');
      capturedUrls.add(snapshot.url);
      records.push({ ...base, status: 'captured', verification: 'unverified', snapshot });
    } catch (error) { records.push({ ...base, status: 'failed', error_code: errorCode(error) }); }
  }
  for (const doc of files) {
    const base = { source_id: sourceId(enterprise, 'document', doc.key), kind: 'document', name: doc.name,
      source_kind: doc.source_kind, source_ref: doc.source_ref };
    try { records.push({ ...base, status: 'captured', verification: 'unverified', document: collectDocument(doc) }); }
    catch (error) { records.push({ ...base, status: 'failed', error_code: errorCode(error) }); }
  }
  const captured = records.filter((record) => record.status === 'captured').length;
  return { schema_version: COLLECTION_SCHEMA, enterprise_id: enterprise, visibility: 'private',
    publication_permission: 'not-granted', created_at: new Date().toISOString(),
    status: captured === records.length ? 'complete' : captured === 0 ? 'failed' : 'partial',
    counts: { requested: records.length, captured, failed: records.length - captured }, records };
}

/** Explicit narrow handoff to the existing builder: only verified hash/host format,
 * never a claim of independent factual verification or publication approval. */
export function projectWebsitePages(bundle, { enterprise_id, company_website }) {
  if (!bundle || bundle.schema_version !== COLLECTION_SCHEMA || bundle.visibility !== 'private' ||
      bundle.enterprise_id !== enterprise_id || bundle.status !== 'complete' || !Array.isArray(bundle.records) ||
      bundle.records.length > LIMITS.websites + LIMITS.documents ||
      bundle.records.some((record) => record?.status !== 'captured'))
    fail('COLLECTION_HANDOFF_BLOCKED', 'A complete private collection for this enterprise is required');
  const company = siteUrl(company_website);
  const pages = bundle.records.filter((record) => record.kind === 'website')
    .map((record) => checkedWebsite(record.snapshot, record.requested_url))
    .filter((snapshot) => sameHost(company, siteUrl(snapshot.url)));
  if (!pages.length || pages.length > LIMITS.websites || new Set(pages.map((page) => page.url)).size !== pages.length)
    fail('COLLECTION_HANDOFF_BLOCKED', 'Unique company website snapshots are required');
  return pages.map((page) => Object.fromEntries(snapshotKeys.map((key) => [key, page[key]])));
}
