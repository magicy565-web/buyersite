import { createHash } from 'node:crypto';

export class KnowledgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KnowledgeError';
    this.code = code;
  }
}

export function requireText(value, name, max = 256) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new KnowledgeError(
      'INVALID_INPUT',
      `${name} must be nonempty text (at most ${max} characters)`,
    );
  }
  return value.trim();
}

export function entityKey(entity) {
  if (!entity || !['company', 'product'].includes(entity.type)) {
    throw new KnowledgeError('INVALID_ENTITY', 'An explicit company or product target is required');
  }
  return `${entity.type}:${requireText(entity.id, 'entity.id', 200)}`;
}

export function normalizeEntity(entity) {
  entityKey(entity);
  return {
    type: entity.type,
    id: entity.id.trim(),
    label: requireText(entity.label || entity.id, 'entity.label', 200),
  };
}

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const stableId = (...parts) => sha256(JSON.stringify(parts)).slice(0, 32);

export function validateAsset(asset, enterpriseId) {
  if (!asset || asset.enterprise_id !== enterpriseId) {
    throw new KnowledgeError(
      'TENANT_MISMATCH',
      'Source does not belong to the trusted enterprise context',
    );
  }
  if (
    !(asset.bytes instanceof Uint8Array) ||
    !asset.bytes.byteLength ||
    asset.bytes.byteLength > 25 * 1024 * 1024
  ) {
    throw new KnowledgeError('INVALID_ASSET_SIZE', 'An asset must contain 1 byte to 25 MiB');
  }
  const bytes = Buffer.from(asset.bytes);
  const digest = sha256(bytes);
  if (asset.sha256 && asset.sha256 !== digest) {
    throw new KnowledgeError(
      'SOURCE_HASH_MISMATCH',
      'Source bytes do not match the supplied SHA-256',
    );
  }
  return {
    source_id: requireText(asset.source_id, 'source_id', 256),
    revision: requireText(String(asset.revision ?? ''), 'revision', 128),
    enterprise_id: enterpriseId,
    entity: normalizeEntity(asset.entity),
    filename: requireText(asset.filename, 'filename', 256),
    media_type: requireText(asset.media_type, 'media_type', 128),
    sha256: digest,
    bytes,
    source_kind: asset.source_kind === 'user-answer' ? 'user-answer' : 'library',
    is_current_version: asset.is_current_version !== false,
    review_state: asset.review_state ?? null,
  };
}

export function fieldName(field, entity) {
  requireText(field, 'field', 100);
  if (
    !/^(company|product)\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(field) ||
    !field.startsWith(`${entity.type}.`)
  ) {
    throw new KnowledgeError('INVALID_FIELD', 'Field must belong to the target entity type');
  }
  return field;
}

// All model output is untrusted. Evidence is resolved from this exact source and parse.
export function validateExtraction(output, { entity, source, parsed }) {
  if (
    !output ||
    !Array.isArray(output.facts) ||
    output.facts.length > 100 ||
    !Array.isArray(output.questions ?? []) ||
    (output.questions?.length ?? 0) > 20
  ) {
    throw new KnowledgeError('INVALID_EXTRACTION', 'Expected at most 100 facts and 20 questions');
  }
  const segments = new Map(parsed.segments.map((segment) => [segment.id, segment]));
  const facts = output.facts.map((candidate) => {
    const field = fieldName(candidate.field, entity);
    const value = requireText(candidate.value, 'fact.value', 2000);
    if (
      !Number.isFinite(candidate.confidence) ||
      candidate.confidence < 0 ||
      candidate.confidence > 1
    ) {
      throw new KnowledgeError('INVALID_CONFIDENCE', 'Confidence must be between zero and one');
    }
    if (
      !Array.isArray(candidate.evidence) ||
      !candidate.evidence.length ||
      candidate.evidence.length > 8
    ) {
      throw new KnowledgeError(
        'EVIDENCE_REQUIRED',
        'Every fact needs one to eight source quotations',
      );
    }
    const evidence = candidate.evidence.map((ref) => {
      const segment = segments.get(ref.segment_id);
      const quote = requireText(ref.quote, 'evidence.quote', 4000);
      if (!segment || !segment.text.includes(quote)) {
        throw new KnowledgeError(
          'INVALID_EVIDENCE',
          'Quotation must occur in a segment of the current source',
        );
      }
      return {
        source_id: source.source_id,
        source_revision: source.revision,
        sha256: source.sha256,
        parse_id: parsed.id,
        segment_id: segment.id,
        quote,
        method: segment.method,
        locator: segment.locator,
      };
    });
    return { field, value, confidence: candidate.confidence, evidence };
  });
  const questions = (output.questions ?? []).map((question) => ({
    field: fieldName(question.field, entity),
    question: requireText(question.question, 'question', 1000),
    why: requireText(question.why, 'why', 1000),
    requested_materials: (question.requested_materials ?? [])
      .slice(0, 8)
      .map((item) => requireText(item, 'requested_material', 300)),
  }));
  return { facts, questions };
}
