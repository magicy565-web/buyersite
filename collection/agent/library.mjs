import { createHash } from 'node:crypto';

const DOCUMENT_ID = /^doc_[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_DOCUMENTS = 10_000;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const text = (value, maximum = 500) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  !/[\u0000-\u001f\u007f]/u.test(value);

export class EnterpriseLibraryError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'EnterpriseLibraryError';
    this.code = code;
    this.status = status;
  }
}

const fail = (code, message, status) => {
  throw new EnterpriseLibraryError(code, message, status);
};
const invalid = () =>
  fail('LIBRARY_INVALID_RESPONSE', 'The enterprise library returned invalid source metadata.');

function configuredOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(
      'LIBRARY_CONFIG_REQUIRED',
      'A host-configured enterprise library origin is required.',
      400,
    );
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !loopback) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    fail(
      'LIBRARY_CONFIG_REQUIRED',
      'Use an HTTPS origin or an HTTP loopback origin without credentials, paths or query parameters.',
      400,
    );
  }
  return url;
}

async function boundedBytes(response, maximum) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))))
    invalid();
  if (declared !== null && Number(declared) > maximum) {
    await response.body?.cancel().catch(() => {});
    fail('LIBRARY_SOURCE_TOO_LARGE', 'The library source exceeds the allowed byte limit.', 413);
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > maximum)
        fail('LIBRARY_SOURCE_TOO_LARGE', 'The library source exceeds the allowed byte limit.', 413);
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof EnterpriseLibraryError) throw error;
    fail('LIBRARY_UNAVAILABLE', 'The library source could not be read completely.', 503);
  }
  if (declared !== null && Number(declared) !== size)
    fail(
      'LIBRARY_SOURCE_CHANGED',
      'The library response length does not match its declared size.',
      409,
    );
  return Buffer.concat(chunks, size);
}

function selectedVersion(payload, documentId, version) {
  const document = payload?.document;
  if (
    !record(document) ||
    document.id !== documentId ||
    !positive(document.revision) ||
    !positive(document.currentVersion) ||
    !Array.isArray(document.versions)
  )
    invalid();
  if (document.status !== 'active')
    fail(
      'LIBRARY_SOURCE_UNAVAILABLE',
      'The selected library document is archived or unavailable.',
      409,
    );
  const selected = version ?? document.currentVersion;
  const matches = document.versions.filter((item) => item?.version === selected);
  if (matches.length !== 1)
    fail('LIBRARY_VERSION_NOT_FOUND', 'The exact document version is unavailable.', 404);
  const entry = matches[0];
  if (
    !SHA256.test(entry.sha256) ||
    !positive(entry.bytes) ||
    !text(entry.fileName, 200) ||
    !text(entry.mimeType, 200)
  )
    invalid();
  if (entry.bytes > MAX_SOURCE_BYTES)
    fail('LIBRARY_SOURCE_TOO_LARGE', 'The library source exceeds 25 MiB.', 413);
  const mediaType = entry.mimeType.split(';', 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mediaType)) invalid();
  const filename = entry.fileName.replace(/\\/g, '/').split('/').at(-1);
  if (!filename || ['.', '..'].includes(filename)) invalid();
  if (entry.attachment) {
    if (
      !record(entry.attachment) ||
      entry.attachment.attachmentId !== 'sha256:' + entry.sha256 ||
      entry.attachment.bytes !== entry.bytes ||
      (typeof entry.content === 'string' && entry.content.length)
    )
      invalid();
  } else if (typeof entry.content !== 'string') invalid();
  return { document, entry, mediaType, filename };
}

function sourceEntity(entity, profile) {
  if (entity === undefined) {
    const company = profile.company;
    return {
      type: 'company',
      id: profile.id,
      label: company?.displayName || company?.legalName || profile.id,
    };
  }
  if (
    !record(entity) ||
    !['company', 'product'].includes(entity.type) ||
    !text(entity.id, 200) ||
    !text(entity.label, 500)
  ) {
    fail(
      'LIBRARY_INVALID_ENTITY',
      'A company or product entity with an id and label is required.',
      400,
    );
  }
  // The host owns entity association. Never infer a tenant from companyId: "company".
  return { type: entity.type, id: entity.id, label: entity.label };
}

/**
 * Read-only adapter for OpenMausBot's /api/enterprise routes.
 * The host constructs it after authenticating the caller and resolving enterpriseId.
 * baseUrl and headers are deployment configuration, never agent/tool input. Headers
 * may contain a host-owned session capability; this adapter never discovers secrets.
 */
export function createEnterpriseLibraryAdapter({
  baseUrl,
  fetchImpl = fetch,
  headers = {},
  enterpriseId,
} = {}) {
  const origin = configuredOrigin(baseUrl);
  if (typeof fetchImpl !== 'function' || !text(enterpriseId, 200)) {
    fail(
      'LIBRARY_CONFIG_REQUIRED',
      'The host must bind an enterprise id and an authenticated transport.',
      400,
    );
  }
  const configuredHeaders = new Headers(headers);

  async function get(path) {
    const target = new URL(path, origin);
    if (target.origin !== origin.origin || !target.pathname.startsWith('/api/enterprise')) {
      fail(
        'LIBRARY_SCOPE_MISMATCH',
        'The source request is outside the configured enterprise library.',
        403,
      );
    }
    let response;
    try {
      response = await fetchImpl(target, {
        method: 'GET',
        headers: new Headers(configuredHeaders),
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      fail(
        'LIBRARY_UNAVAILABLE',
        'The authenticated enterprise library could not be reached.',
        503,
      );
    }
    if (!response || typeof response.status !== 'number' || !response.headers?.get) invalid();
    if (
      response.redirected ||
      (response.status >= 300 && response.status < 400) ||
      (response.url && new URL(response.url).origin !== origin.origin)
    ) {
      await response.body?.cancel().catch(() => {});
      fail('LIBRARY_REDIRECT_BLOCKED', 'Enterprise library redirects are not allowed.', 403);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if ([401, 403].includes(response.status))
        fail(
          'LIBRARY_AUTH_REQUIRED',
          'The host library session cannot read this enterprise.',
          response.status,
        );
      if (response.status === 404)
        fail('LIBRARY_SOURCE_NOT_FOUND', 'The selected library source was not found.', 404);
      fail('LIBRARY_UNAVAILABLE', 'The enterprise library rejected the source read.', 503);
    }
    return response;
  }

  async function json(path) {
    const response = await get(path);
    const bytes = await boundedBytes(response, MAX_METADATA_BYTES);
    let value;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      invalid();
    }
    if (!record(value) || value.ok === false) invalid();
    return value.ok === true ? value.data : value;
  }

  async function boundProfile() {
    const profile = await json('/api/enterprise');
    if (!record(profile) || profile.id !== enterpriseId) {
      fail(
        'LIBRARY_SCOPE_MISMATCH',
        'The authenticated enterprise does not match the host binding.',
        403,
      );
    }
    return profile;
  }

  return Object.freeze({
    async listDocuments() {
      await boundProfile();
      const items = [],
        seen = new Set();
      let offset = 0,
        sequence;
      for (let pageNumber = 0; pageNumber < 1_000; pageNumber++) {
        const page = await json(
          '/api/enterprise/library/documents?status=active&limit=200&offset=' + offset,
        );
        if (
          !record(page) ||
          !Array.isArray(page.items) ||
          page.items.length > 200 ||
          !Number.isSafeInteger(page.sequence) ||
          page.sequence < 0 ||
          page.offset !== offset ||
          typeof page.hasMore !== 'boolean'
        )
          invalid();
        if (sequence !== undefined && page.sequence !== sequence) {
          fail(
            'LIBRARY_SOURCE_CHANGED',
            'The library changed during pagination. Read its document list again.',
            409,
          );
        }
        sequence = page.sequence;
        for (const item of page.items) {
          if (
            !DOCUMENT_ID.test(item?.id) ||
            seen.has(item.id) ||
            item.status !== 'active' ||
            !positive(item.currentVersion) ||
            !positive(item.revision) ||
            !text(item.title, 200)
          )
            invalid();
          seen.add(item.id);
          items.push({
            source_id: 'library:' + item.id,
            document_id: item.id,
            enterprise_id: enterpriseId,
            title: item.title,
            revision: String(item.currentVersion),
            document_revision: item.revision,
            slot_key: item.slotKey,
            review_state: item.reviewState,
            has_file: item.hasFile === true,
            has_inline_text: item.hasInlineText === true,
          });
        }
        if (items.length > MAX_DOCUMENTS)
          fail(
            'LIBRARY_SOURCE_TOO_LARGE',
            'The library document list exceeds the bounded import size.',
            413,
          );
        if (!page.hasMore) {
          await boundProfile();
          return items;
        }
        if (!positive(page.nextOffset) || page.nextOffset <= offset || !page.items.length)
          invalid();
        offset = page.nextOffset;
      }
      fail(
        'LIBRARY_SOURCE_TOO_LARGE',
        'The library document list exceeds the bounded import size.',
        413,
      );
    },

    async readDocument({ documentId, version, entity } = {}) {
      if (!DOCUMENT_ID.test(documentId) || (version !== undefined && !positive(version))) {
        fail(
          'LIBRARY_INVALID_REFERENCE',
          'Use an exact document id and an optional positive version.',
          400,
        );
      }
      const profile = await boundProfile();
      const associatedEntity = sourceEntity(entity, profile);
      const documentPath = '/api/enterprise/library/documents/' + documentId;
      const { entry, mediaType, filename } = selectedVersion(
        await json(documentPath),
        documentId,
        version,
      );
      // Freeze the selected version before downloading; never substitute a newer one.
      const bytes = entry.attachment
        ? await boundedBytes(
            await get(documentPath + '/versions/' + entry.version + '/file'),
            MAX_SOURCE_BYTES,
          )
        : Buffer.from(entry.content, 'utf8');
      if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) {
        fail(
          'LIBRARY_SOURCE_CHANGED',
          'The source bytes do not match the selected version and SHA-256.',
          409,
        );
      }
      const afterSource = selectedVersion(await json(documentPath), documentId, entry.version);
      const after = afterSource.entry;
      if (
        after.sha256 !== entry.sha256 ||
        after.bytes !== entry.bytes ||
        after.mimeType !== entry.mimeType ||
        after.fileName !== entry.fileName ||
        after.attachment?.attachmentId !== entry.attachment?.attachmentId
      ) {
        fail(
          'LIBRARY_SOURCE_CHANGED',
          'The selected library version changed during the read.',
          409,
        );
      }
      await boundProfile();
      const review = [...(afterSource.document.reviews ?? [])]
        .reverse()
        .find((item) => item.documentVersion === entry.version && item.sha256 === entry.sha256);
      return {
        source_id: 'library:' + documentId,
        revision: String(entry.version),
        enterprise_id: enterpriseId,
        entity: associatedEntity,
        filename,
        media_type: mediaType,
        sha256: entry.sha256,
        bytes,
        review_state: ['verified', 'rejected'].includes(review?.decision)
          ? review.decision
          : 'unreviewed',
        is_current_version: afterSource.document.currentVersion === entry.version,
      };
    },
  });
}
