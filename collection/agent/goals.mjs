import { createHash } from 'node:crypto';

const COMPANY_REQUIREMENTS = [
  {
    field: 'company.display_name',
    label: '企业名称',
    priority: 100,
    question: '请确认企业对外使用的名称；如与营业执照名称不同，请一并说明。',
    why: '用于把不同资料中的企业称呼对应到同一个企业。',
    requested_materials: ['企业简介', '企业名称的文字或语音说明'],
  },
  {
    field: 'company.business_scope',
    label: '主营业务',
    priority: 90,
    question: '企业主要提供哪些产品或加工服务？请说明实际生产或服务范围。',
    why: '用于明确后续产品和工艺资料的归属，避免把示例或外购业务当成自有能力。',
    requested_materials: ['企业简介或产品目录', '主营业务的文字或语音说明'],
  },
];

const PRODUCT_REQUIREMENTS = [
  {
    field: 'product.model',
    label: '产品型号',
    priority: 100,
    question: '这份资料对应哪个产品型号？若没有型号，请说明你们使用的产品编号或识别名称。',
    why: '用于关联同一产品的画册、图片、规格表和后续补充资料。',
    requested_materials: ['型号标签或铭牌近照', '产品编号的文字或语音说明'],
  },
  {
    field: 'product.name',
    label: '产品名称',
    priority: 95,
    question: '这个产品的正式名称是什么？如有内部简称或旧名称，请一并说明。',
    why: '用于区分产品名称和型号，并识别后续资料中的不同称呼。',
    requested_materials: ['产品名称的文字或语音说明', '产品目录对应页面'],
  },
  {
    field: 'product.material',
    label: '材质成分',
    priority: 90,
    question: '这个型号使用什么材质或成分？请保留比例、涂层和不同版本的区别。',
    why: '外观不能可靠说明材质，材质信息需要资料或明确说明支持。',
    requested_materials: ['材质说明或技术规格表', '成分标签近照', '材质的文字或语音说明'],
  },
  {
    field: 'product.specifications',
    label: '技术规格',
    priority: 85,
    question: '请补充这个型号的关键尺寸、性能或其他技术参数，并注明单位和适用版本。',
    why: '用于保留参数的单位、范围和适用条件，避免不同版本混用。',
    requested_materials: ['产品规格表', '画册参数页高清图', '关键参数的文字或语音说明'],
  },
  {
    field: 'product.moq',
    label: '起订量',
    priority: 60,
    question: '这个型号的起订量是多少？请注明数量单位，以及颜色、规格或定制条件是否影响起订量。',
    why: '起订量不能由包装数量或历史订单数量推断。',
    requested_materials: ['适用于该型号的起订条件', '起订量的文字或语音说明'],
  },
  {
    field: 'product.lead_time',
    label: '交期',
    priority: 55,
    question: '这个型号通常需要多长交期？请区分现货、样品和量产，并说明计时起点和适用条件。',
    why: '交期依赖订单和生产条件，不能直接沿用其他产品或旧订单的数值。',
    requested_materials: ['该型号的生产或交付条件', '交期的文字或语音说明'],
  },
];

export const LEARNING_LIMITS = Object.freeze({ facts: 40, corrections: 20, disputed_fields: 64 });
const FIELD = /^(company|product)\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
const activeStatuses = new Set(['candidate', 'confirmed']);
const nonempty = (value, max = 2_000) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validField = (field, type) =>
  nonempty(field, 200) && FIELD.test(field) && field.startsWith(type + '.');
const normalizeValue = (value) => value.trim().replace(/\s+/g, ' ');
const display = (value, max = 160) => {
  const normalized = normalizeValue(value);
  return normalized.length > max ? normalized.slice(0, max) + '…' : normalized;
};
const invalid = (message) => {
  const error = new TypeError(message);
  error.code = 'KNOWLEDGE_GOAL_INVALID';
  throw error;
};

function entityKey(entity) {
  if (!entity || !['company', 'product'].includes(entity.type) || !nonempty(entity.id, 200))
    invalid('A scoped company or product entity is required');
  return `${entity.type}:${entity.id}`;
}

function inScope(row, key) {
  return row && (row.entity_key == null || row.entity_key === key) && row.stale !== true;
}

function activeFacts(facts, key, type) {
  if (!Array.isArray(facts) || facts.length > 20_000)
    invalid('Facts must be a bounded array scoped by the caller');
  return facts.filter(
    (fact) =>
      inScope(fact, key) &&
      activeStatuses.has(fact.status) &&
      validField(fact.field, type) &&
      nonempty(fact.id, 200) &&
      nonempty(fact.value, 20_000),
  );
}

function requirementsFor(entity, requirements) {
  const selected =
    requirements ?? (entity.type === 'company' ? COMPANY_REQUIREMENTS : PRODUCT_REQUIREMENTS);
  if (!Array.isArray(selected) || selected.length > 64)
    invalid('Requirements must be an array of at most 64 fields');
  const seen = new Set();
  return selected.map((requirement) => {
    if (
      !requirement ||
      !validField(requirement.field, entity.type) ||
      seen.has(requirement.field) ||
      !nonempty(requirement.label, 100) ||
      !nonempty(requirement.question, 1_000) ||
      !nonempty(requirement.why, 1_000) ||
      !Number.isFinite(requirement.priority) ||
      !Array.isArray(requirement.requested_materials) ||
      requirement.requested_materials.length > 8 ||
      requirement.requested_materials.some((material) => !nonempty(material, 200)) ||
      (requirement.evidence_required != null && typeof requirement.evidence_required !== 'boolean')
    )
      invalid('Each requirement must declare a unique scoped field and bounded question metadata');
    seen.add(requirement.field);
    return requirement;
  });
}

function hasDocumentEvidence(fact) {
  return (
    Array.isArray(fact.evidence) &&
    fact.evidence.some(
      (evidence) =>
        evidence &&
        evidence.method !== 'user-statement' &&
        nonempty(evidence.source_id, 200) &&
        (nonempty(evidence.source_revision, 200) ||
          Number.isSafeInteger(evidence.source_revision)) &&
        /^[a-f0-9]{64}$/i.test(evidence.sha256 || '') &&
        nonempty(evidence.segment_id, 200) &&
        nonempty(evidence.quote, 20_000),
    )
  );
}

function gapReason(facts, requirement) {
  if (!facts.length) return 'missing';
  if (new Set(facts.map((fact) => normalizeValue(fact.value))).size > 1) return 'conflict';
  if (!facts.some((fact) => fact.status === 'confirmed')) return 'unconfirmed';
  if (requirement.evidence_required && !facts.some(hasDocumentEvidence)) return 'evidence_missing';
  return null;
}

function makeQuestion(key, entity, requirement, reason, facts) {
  const subject = nonempty(entity.label, 200) ? entity.label.trim() : entity.id;
  const values = [...new Set(facts.map((fact) => normalizeValue(fact.value)))].sort();
  const excerpt = values
    .slice(0, 3)
    .map((value) => `“${display(value)}”`)
    .join(' / ');
  let question = requirement.question;
  if (reason === 'conflict') {
    question = `“${subject}”的“${requirement.label}”存在不一致记录：${excerpt}。目前应采用哪个值？请说明适用型号、版本或条件，并补充对应资料。`;
  } else if (reason === 'unconfirmed') {
    question = `目前提取到“${subject}”的“${requirement.label}”为${excerpt}，尚未确认。请核对是否适用；若有误，请提供正确值及适用条件。`;
  } else if (reason === 'evidence_missing') {
    question = `“${subject}”的“${requirement.label}”已记录为${excerpt}，但仍缺少可核对的资料。请补充${requirement.requested_materials.join('、') || '支持这一信息的原始资料'}。`;
  }
  // A stable field/reason identity survives retries and candidate arrival order.
  const id =
    'question_' +
    createHash('sha256')
      .update(JSON.stringify([key, requirement.field, reason]))
      .digest('hex')
      .slice(0, 24);
  return {
    id,
    entity_key: key,
    field: requirement.field,
    reason,
    priority: requirement.priority,
    question,
    why: requirement.why,
    requested_materials: [...requirement.requested_materials],
    candidate_ids: [...new Set(facts.map((fact) => fact.id))].sort(),
  };
}

/** The trusted caller scopes all records to one enterprise before calling this module. */
export function assessGaps({ entity, facts, requirements, deferredFields = [] }) {
  const key = entityKey(entity);
  const selected = requirementsFor(entity, requirements);
  const active = activeFacts(facts, key, entity.type);
  if (!Array.isArray(deferredFields) || deferredFields.some((field) => typeof field !== 'string'))
    invalid('Deferred fields must be an array of field names');
  const deferred = new Set(deferredFields);
  const summary = {
    required: selected.length,
    satisfied: 0,
    missing: 0,
    conflict: 0,
    unconfirmed: 0,
    evidence_missing: 0,
    deferred: 0,
  };
  const questions = [];
  for (const requirement of selected) {
    const matches = active.filter((fact) => fact.field === requirement.field);
    const reason = gapReason(matches, requirement);
    if (!reason) {
      summary.satisfied += 1;
      continue;
    }
    if (deferred.has(requirement.field)) {
      summary.deferred += 1;
      continue;
    }
    summary[reason] += 1;
    questions.push(makeQuestion(key, entity, requirement, reason, matches));
  }
  questions.sort(
    (left, right) => right.priority - left.priority || left.field.localeCompare(right.field),
  );
  return { questions, ready: summary.satisfied === summary.required, summary };
}

/** Corrections are human-confirmed rows supplied by the trusted store, not model proposals. */
export function buildLearningContext({ entity, facts, corrections = [] }) {
  const key = entityKey(entity);
  const active = activeFacts(facts, key, entity.type);
  if (!Array.isArray(corrections) || corrections.length > 20_000)
    invalid('Corrections must be a bounded array from the confirmed memory store');
  const values = new Map();
  for (const fact of active) {
    if (!values.has(fact.field)) values.set(fact.field, new Set());
    values.get(fact.field).add(normalizeValue(fact.value));
  }
  const disputed = new Set(
    [...values].filter(([, entries]) => entries.size > 1).map(([field]) => field),
  );
  const seen = new Set();
  const eligibleFacts = active.filter((fact) => {
    if (
      fact.status !== 'confirmed' ||
      disputed.has(fact.field) ||
      fact.value.length > 2_000 ||
      seen.has(fact.field)
    )
      return false;
    seen.add(fact.field);
    return true;
  });
  const confirmedFacts = eligibleFacts.slice(0, LEARNING_LIMITS.facts).map((fact) => ({
    id: fact.id,
    field: fact.field,
    value: fact.value,
    evidence: (Array.isArray(fact.evidence) ? fact.evidence : []).slice(0, 2).map((evidence) => ({
      source_id: String(evidence?.source_id ?? '').slice(0, 200),
      source_revision: String(evidence?.source_revision ?? '').slice(0, 200),
      sha256: String(evidence?.sha256 ?? '').slice(0, 64),
      segment_id: String(evidence?.segment_id ?? '').slice(0, 200),
      quote: String(evidence?.quote ?? '').slice(0, 500),
      method: String(evidence?.method ?? '').slice(0, 100),
    })),
  }));
  const eligibleCorrections = corrections.filter(
    (correction) =>
      inScope(correction, key) &&
      (correction.status == null || correction.status === 'confirmed') &&
      correction.confirmed !== false &&
      validField(correction.field, entity.type) &&
      !disputed.has(correction.field) &&
      nonempty(correction.corrected_value, 2_000) &&
      (correction.previous_value == null || nonempty(correction.previous_value, 2_000)) &&
      (correction.reason == null || typeof correction.reason === 'string'),
  );
  // The newest correction examples are most useful; the store returns chronological rows.
  const correctionExamples = eligibleCorrections
    .slice(-LEARNING_LIMITS.corrections)
    .map((correction) => ({
      field: correction.field,
      previous_value: correction.previous_value ?? null,
      corrected_value: correction.corrected_value,
      reason: String(correction.reason ?? '').slice(0, 1_000),
    }));
  return {
    entity_key: key,
    confirmed_facts: confirmedFacts,
    correction_examples: correctionExamples,
    disputed_fields: [...disputed].sort().slice(0, LEARNING_LIMITS.disputed_fields),
    limits: { ...LEARNING_LIMITS },
    truncated: {
      facts:
        eligibleFacts.length > confirmedFacts.length ||
        active.some((fact) => fact.status === 'confirmed' && fact.value.length > 2_000),
      corrections: eligibleCorrections.length > correctionExamples.length,
      disputed_fields: disputed.size > LEARNING_LIMITS.disputed_fields,
    },
  };
}
