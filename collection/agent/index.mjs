import {
  KnowledgeError,
  entityKey,
  fieldName,
  normalizeEntity,
  requireText,
  sha256,
  stableId,
  validateExtraction,
} from './contracts.mjs';
import { openKnowledgeStore } from './store.mjs';
import { ParseError, parseAsset } from './parse.mjs';
import { assessGaps, buildLearningContext } from './goals.mjs';

export function createInformationAgent({
  databasePath,
  principal,
  library,
  provider,
  parserOptions = {},
  requirements,
}) {
  const store = openKnowledgeStore({
    path: databasePath,
    enterpriseId: principal?.enterpriseId,
    actorId: principal?.actorId,
  });
  const scopedFacts = (entity) => store.listFacts(entity).filter((fact) => !fact.stale);
  const learningContext = (entity) =>
    buildLearningContext({
      entity,
      facts: scopedFacts(entity),
      corrections: store.corrections(entity),
    });

  async function analyzeSource({ source_id, revision, entity: inputEntity, reparse = false }) {
    const entity = normalizeEntity(inputEntity);
    store.assertLink(source_id, revision, entity);
    const source = store.source(source_id, revision, { includeBytes: true });
    if (!source.active)
      throw new KnowledgeError(
        'STALE_SOURCE',
        'Historical source versions are retained for evidence, but cannot teach current facts',
      );
    let parsed = !reparse && store.latestParse(source_id, revision);
    if (!parsed || parsed.status === 'failed') {
      try {
        parsed = store.saveParse(
          source_id,
          revision,
          await parseAsset(source, {
            ...parserOptions,
            transcribe: provider?.transcribe ?? parserOptions.transcribe,
            describeImage: provider?.describeImage ?? parserOptions.describeImage,
          }),
        );
      } catch (error) {
        parsed = store.saveParse(source_id, revision, {
          status: 'failed',
          segments: [],
          missing_processors: [],
          warnings: [
            {
              code: error.code || 'PARSE_FAILED',
              message:
                error instanceof ParseError && error.code !== 'PARSER_FAILED'
                  ? error.message
                  : 'Source could not be parsed; inspect the file or parser configuration.',
            },
          ],
        });
      }
    }
    const base = {
      parse_id: parsed.id,
      facts: [],
      questions: [],
      warnings: parsed.warnings ?? [],
      missing_processors: parsed.missing_processors ?? [],
    };
    if (!parsed.segments.length || !provider?.extract) {
      const status = !parsed.segments.length
        ? 'needs_material_or_processor'
        : 'needs_semantic_provider';
      store.saveAnalysis(source_id, revision, entity, { ...base, status });
      return {
        status,
        source: store.source(source_id, revision),
        parsed,
        ...getNextQuestions({ entity }),
      };
    }
    const context = learningContext(entity);
    try {
      const raw = await provider.extract({
        entity,
        source: store.source(source_id, revision),
        segments: parsed.segments,
        learning: context,
        requirements: requirements ?? assessGaps({ entity, facts: [] }).questions,
      });
      const validated = validateExtraction(raw, { entity, source, parsed });
      const result = store.transaction(() => {
        const facts = validated.facts.map((fact) => store.saveCandidate(entity, fact));
        const status = parsed.status === 'ready' ? 'analyzed' : 'partially_analyzed';
        store.saveAnalysis(source_id, revision, entity, {
          ...base,
          status,
          fact_ids: facts.map((fact) => fact.id),
          questions: validated.questions,
          learning_fact_ids: (context.confirmed_facts ?? []).map((fact) => fact.id),
          learning_correction_count: context.correction_examples?.length ?? 0,
        });
        return { status, facts };
      });
      return {
        ...result,
        source: store.source(source_id, revision),
        ...getNextQuestions({ entity }),
      };
    } catch (error) {
      // No partial model response can become knowledge. Originals and parse evidence remain available.
      store.saveAnalysis(source_id, revision, entity, {
        ...base,
        status: 'analysis_failed',
        error_code: error.code || 'PROVIDER_FAILED',
      });
      throw error;
    }
  }

  async function ingestAsset(asset, { analyze = true } = {}) {
    const source = store.putSource(asset);
    if (!analyze || !source.active)
      return { status: source.active ? 'received' : 'historical', source };
    return analyzeSource({
      source_id: source.source_id,
      revision: source.revision,
      entity: source.entity,
    });
  }
  async function ingestLibraryDocument(request, options) {
    if (!library?.readDocument)
      throw new KnowledgeError(
        'LIBRARY_NOT_CONFIGURED',
        'Configure the authenticated enterprise library adapter',
      );
    return ingestAsset(await library.readDocument(request), options);
  }

  function getNextQuestions({ entity: inputEntity, limit = 3 }) {
    const entity = normalizeEntity(inputEntity);
    const key = entityKey(entity);
    const facts = scopedFacts(entity);
    const deferrals = store.deferrals(entity);
    const deferred = new Set(deferrals.map((row) => row.field));
    const assessment = assessGaps({ entity, facts, requirements, deferredFields: [...deferred] });
    const questions = [...assessment.questions];
    const requiredFields = new Set(
      (requirements ?? assessGaps({ entity, facts: [] }).questions).map((item) => item.field),
    );
    const optionalFields = [
      ...new Set(
        facts
          .filter(
            (fact) =>
              ['candidate', 'confirmed'].includes(fact.status) && !requiredFields.has(fact.field),
          )
          .map((fact) => fact.field),
      ),
    ];
    let optionalPending = 0;
    for (let offset = 0; offset < optionalFields.length; offset += 64) {
      const optional = assessGaps({
        entity,
        facts,
        deferredFields: [...deferred],
        requirements: optionalFields.slice(offset, offset + 64).map((field) => ({
          field,
          label: field,
          priority: 40,
          question: `请核对「${entity.label}」的 ${field} 信息，并说明适用条件。`,
          why: '补充提取的信息也需要确认，出现矛盾时需要明确采用哪个值。',
          requested_materials: ['支持该信息的原始资料或明确说明'],
        })),
      });
      optionalPending += optional.summary.required - optional.summary.satisfied;
      questions.push(...optional.questions);
    }
    const analyses = store.listAnalyses(entity);
    const supplements = store.supplements(entity);
    let pending = 0;
    for (const source of store
      .listSources(entity)
      .filter((item) => item.active && item.source_kind !== 'user-answer')) {
      const analysis = analyses.find(
        (item) => item.source_id === source.source_id && item.revision === source.revision,
      );
      const supplement = supplements.find(
        (item) => item.source_id === source.source_id && item.revision === source.revision,
      );
      const supplemented =
        supplement &&
        analyses.some(
          (item) =>
            item.source_id === supplement.replacement_source_id &&
            item.revision === supplement.replacement_revision &&
            item.status === 'analyzed',
        );
      if ((!analysis || analysis.status !== 'analyzed') && !supplemented) {
        pending++;
        const field = `$source:${source.source_id}:${source.revision}`;
        if (!deferred.has(field))
          questions.push({
            id: stableId(key, field),
            entity_key: key,
            field,
            reason: 'processor_or_material',
            priority: 95,
            question: `「${source.filename}」尚未完成信息提取。请补充可读取的文字稿、清晰原文件，或配置并重试对应的解析服务。`,
            why:
              analysis?.status === 'needs_semantic_provider'
                ? '已读取原文，但尚未配置语义提取模型。'
                : '资料处理未完成，不能据此认定信息齐全。',
            requested_materials: ['可读取的原始文件或文字稿'],
            candidate_ids: [],
            source_id: source.source_id,
            source_revision: source.revision,
            missing_processors: analysis?.missing_processors ?? [],
            warnings: analysis?.warnings ?? [],
            error_code: analysis?.error_code ?? null,
          });
      }
      for (const question of analysis?.questions ?? []) {
        const answered = facts.some(
          (fact) =>
            fact.field === question.field &&
            fact.status === 'confirmed' &&
            fact.reviewed_at >= analysis.analyzed_at,
        );
        if (!answered && !deferred.has(question.field))
          questions.push({
            ...question,
            id: stableId(key, question.field, source.source_id, 'uncertain'),
            entity_key: key,
            reason: 'uncertain',
            priority: 85,
            candidate_ids: [],
            source_id: source.source_id,
            source_revision: source.revision,
          });
      }
    }
    const ordered = questions.sort(
      (a, b) =>
        Number(b.reason === 'conflict') - Number(a.reason === 'conflict') ||
        b.priority - a.priority ||
        a.id.localeCompare(b.id),
    );
    const unique = [...new Map(ordered.map((question) => [question.id, question])).values()];
    const count = Number.isInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 3;
    return {
      ready: assessment.ready && pending === 0 && optionalPending === 0 && unique.length === 0,
      questions: unique.slice(0, count).map((question) => ({
        ...question,
        supporting_evidence: (question.candidate_ids ?? [])
          .flatMap((id) => facts.find((fact) => fact.id === id)?.evidence ?? [])
          .slice(0, 16),
      })),
      total_open: unique.length,
      deferred: deferrals,
      summary: {
        ...assessment.summary,
        optional_pending: optionalPending,
        pending_sources: pending,
      },
    };
  }

  function statement({
    entity,
    field,
    value,
    reference,
    request_id,
    reason = '',
    replace = false,
  }) {
    fieldName(field, entity);
    requireText(value, 'answer', 2000);
    requireText(request_id, 'request_id', 200);
    const sourceId = `answer:${stableId(store.actorId, request_id)}`;
    const bytes = Buffer.from(
      JSON.stringify({ entity_key: entityKey(entity), field, value, reference, reason }),
    );
    return store.transaction(() => {
      store.putSource({
        source_id: sourceId,
        revision: '1',
        enterprise_id: store.enterpriseId,
        entity,
        filename: `${sourceId}.txt`,
        media_type: 'text/plain',
        bytes,
        sha256: sha256(bytes),
        source_kind: 'user-answer',
      });
      const parsed =
        store.latestParse(sourceId, '1') ??
        store.saveParse(sourceId, '1', {
          status: 'ready',
          warnings: [],
          missing_processors: [],
          segments: [
            {
              id: 'answer',
              text: value,
              locator: { kind: 'lines', start_line: 1, end_line: value.split('\n').length },
              method: 'user-statement',
            },
          ],
        });
      const validated = validateExtraction(
        {
          facts: [
            { field, value, confidence: 1, evidence: [{ segment_id: 'answer', quote: value }] },
          ],
          questions: [],
        },
        { entity, source: store.source(sourceId, '1'), parsed },
      );
      const fact = store.saveCandidate(entity, validated.facts[0]);
      return store.reviewFact(fact.id, { action: 'confirm', replace, reason });
    });
  }

  function reviewFact({
    entity: inputEntity,
    fact_id,
    action,
    value,
    reason = '',
    request_id,
    replace = false,
  }) {
    const entity = normalizeEntity(inputEntity);
    const fact = store.getFact(fact_id);
    if (fact.entity_key !== entityKey(entity))
      throw new KnowledgeError('FACT_ENTITY_MISMATCH', 'Fact belongs to another entity');
    const reviewed =
      action === 'correct'
        ? statement({
            entity,
            field: fact.field,
            value,
            reference: fact_id,
            request_id,
            reason: requireText(reason, 'correction reason', 2000),
            replace: true,
          })
        : store.reviewFact(fact_id, { action, reason, replace });
    return { fact: reviewed, ...getNextQuestions({ entity }) };
  }

  function answerQuestion({
    entity: inputEntity,
    question_id,
    answer,
    request_id,
    reason = '',
    replace = false,
  }) {
    const entity = normalizeEntity(inputEntity);
    requireText(answer, 'answer', 2000);
    requireText(request_id, 'request_id', 200);
    const sourceId = `answer:${stableId(store.actorId, request_id)}`;
    const previous = store
      .listFacts(entity)
      .find((fact) => fact.evidence.some((ref) => ref.source_id === sourceId));
    if (previous) {
      const record = JSON.parse(
        store.source(sourceId, '1', { includeBytes: true }).bytes.toString('utf8'),
      );
      if (record.value !== answer || record.reference !== question_id || record.reason !== reason)
        throw new KnowledgeError(
          'REQUEST_CONFLICT',
          'This request_id was already used for another answer',
        );
      return { fact: previous, ...getNextQuestions({ entity }) };
    }
    const question = getNextQuestions({ entity, limit: 100 }).questions.find(
      (item) => item.id === question_id,
    );
    if (!question)
      throw new KnowledgeError(
        'QUESTION_NOT_OPEN',
        'Question has already been resolved or does not belong to this entity',
      );
    if (
      /^(不知道|不清楚|稍后补|以后再问|暂不提供|不适用|unknown|later|not applicable)$/i.test(
        answer.trim(),
      )
    ) {
      store.setDeferral(entity, question.field, answer.trim());
      return getNextQuestions({ entity });
    }
    if (question.field.startsWith('$source:'))
      throw new KnowledgeError(
        'MATERIAL_REQUIRED',
        'Import supplementary material or retry the parser for this source',
      );
    const fact = statement({
      entity,
      field: question.field,
      value: answer,
      reference: question_id,
      request_id,
      reason,
      replace,
    });
    return { fact, ...getNextQuestions({ entity }) };
  }

  return {
    ingestAsset,
    ingestLibraryDocument,
    analyzeSource,
    getNextQuestions,
    reviewFact,
    answerQuestion,
    listLibraryDocuments: async () => {
      if (!library?.listDocuments)
        throw new KnowledgeError(
          'LIBRARY_NOT_CONFIGURED',
          'Configure the authenticated enterprise library adapter',
        );
      const documents = await library.listDocuments();
      if (
        !Array.isArray(documents) ||
        documents.some((document) => document.enterprise_id !== store.enterpriseId)
      )
        throw new KnowledgeError(
          'TENANT_MISMATCH',
          'Library listing does not belong to this enterprise',
        );
      return documents;
    },
    getKnowledge: ({ entity: inputEntity }) => {
      const entity = normalizeEntity(inputEntity);
      return {
        entity,
        facts: store.listFacts(entity),
        learning: learningContext(entity),
        sources: store.listSources(entity),
        supplements: store.supplements(entity),
        ...getNextQuestions({ entity }),
      };
    },
    linkSupplement: ({
      entity: inputEntity,
      question_id,
      replacement_source_id,
      replacement_revision,
      reason,
    }) => {
      const entity = normalizeEntity(inputEntity);
      const question = getNextQuestions({ entity, limit: 100 }).questions.find(
        (item) => item.id === question_id && item.reason === 'processor_or_material',
      );
      if (!question)
        throw new KnowledgeError('QUESTION_NOT_OPEN', 'Select an open source-processing question');
      store.assertLink(replacement_source_id, replacement_revision, entity);
      const replacement = store
        .listAnalyses(entity)
        .find(
          (item) =>
            item.source_id === replacement_source_id &&
            item.revision === String(replacement_revision),
        );
      if (
        replacement?.status !== 'analyzed' ||
        (replacement_source_id === question.source_id &&
          String(replacement_revision) === question.source_revision)
      )
        throw new KnowledgeError(
          'SUPPLEMENT_NOT_READY',
          'The supplementary source must be distinct, current and successfully analyzed',
        );
      const supplement = store.linkSupplement(
        entity,
        question.source_id,
        question.source_revision,
        replacement_source_id,
        replacement_revision,
        reason,
      );
      return { supplement, ...getNextQuestions({ entity }) };
    },
    deferQuestion: ({ entity, question_id, reason }) => {
      const question = getNextQuestions({ entity, limit: 100 }).questions.find(
        (item) => item.id === question_id,
      );
      if (!question) throw new KnowledgeError('QUESTION_NOT_OPEN', 'Question is not open');
      store.setDeferral(entity, question.field, reason);
      return getNextQuestions({ entity });
    },
    resumeField: ({ entity, field }) => {
      store.resumeField(entity, field);
      return getNextQuestions({ entity });
    },
    audit: store.audit,
    close: store.close,
  };
}
