# Internal information acquisition agent

Phase one of the Buyersite refactor acquires knowledge from the enterprise's existing library: voice recordings, text, images, documents, spreadsheets and PDF brochures. It preserves originals, extracts source-linked candidate facts, requests missing information, and reuses human-confirmed knowledge and corrections on the next extraction.

This is an independent server module. It does not require Astro, generate public pages, publish a site, or make procurement decisions. The earlier website/raw collector remains available for site-builder compatibility; see the appendix.

## Entry points and trust boundary

| Entry point                              | Purpose                                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [agent/index.mjs](agent/index.mjs)       | `createInformationAgent`: ingestion, extraction, questions, knowledge and authenticated human actions |
| [agent/cli.mjs](agent/cli.mjs)           | JSON requests for a trusted local operator                                                            |
| [agent/tools.mjs](agent/tools.mjs)       | `createCollectionTools`: definitions and dispatcher for an existing Agent/MCP host                    |
| [agent/library.mjs](agent/library.mjs)   | Read-only adapter for the running enterprise server's `/api/enterprise` library routes                |
| [agent/provider.mjs](agent/provider.mjs) | Explicitly configured semantic, transcription and image-vision provider                               |
| [agent/parse.mjs](agent/parse.mjs)       | Local extraction with page, line, sheet, image or recording locations                                 |

The authenticated host supplies `principal: { enterpriseId, actorId }`, the library origin and credentials, model configuration, and a private database path. These values must not come from uploaded documents, model tool arguments, or an untrusted browser request. The host also authorizes the selected company/product and each human review action. SQLite tenant scoping is not an authentication system.

The library adapter accepts a host-configured HTTPS origin, or HTTP on loopback. It reads the authenticated enterprise profile, checks its ID before and after reads, selects an exact document version, checks bytes and SHA-256, and blocks redirects. It does not discover credentials or accept arbitrary download URLs. Library review metadata is retained; even a library document marked verified produces candidate facts requiring review.

Store the database, its WAL files, request files and exports outside `public/`, `dist/` and any served directory. Use a persistent private directory with host-controlled access. This module neither exposes a public endpoint nor deploys or publishes anything.

## Supported material

| Material                                      | Actual extraction and location                                              | Current boundary                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UTF-8 TXT, Markdown, CSV, TSV, JSON           | Original text in line ranges; JSON syntax checked                           | CSV/TSV remain text for semantic extraction; invalid UTF-8 and binary text fail                                                                                               |
| PDF                                           | Embedded text by page; otherwise rendered-page OCR when available           | Requires PyMuPDF; scanned pages also need Pillow, Tesseract and installed source languages                                                                                    |
| DOCX                                          | Body paragraphs and table rows with paragraph/table identifiers             | Locations are extraction order, not printed pages; headers, footers, notes, images, text boxes, nested tables and tracked changes can remain unprocessed and produce warnings |
| XLSX                                          | Cell text with sheet names, row locations and cell addresses                | No formula execution; cached formula results can be stale; missing caches and embedded visuals produce incomplete-content warnings                                            |
| PNG, JPEG, WebP, TIFF, BMP, GIF               | Validated raster frames, OCR text, optional image-vision description        | Local OCR needs Pillow/Tesseract; image vision needs an explicit hook; the included remote vision provider accepts PNG/JPEG/WebP/GIF                                          |
| WAV, MP3, M4A, AAC, OGG/OGA, Opus, FLAC, WebM | Explicit transcription hook; recording location or validated timed segments | Actual codec acceptance depends on the configured transcription service; no local ASR model is bundled                                                                        |

PDF brochures are not fully understood visually. Pages with embedded text are read as text; separate embedded images on those pages trigger a partial-content warning and are not automatically OCRed or sent to vision. Pages without embedded text use page OCR where available. Diagrams, product appearance and image meaning require separate suitable material or a future visual-page workflow.

The included transcription provider normally accepts a whole-recording text response. Such evidence points to the recording and includes `TRANSCRIPT_UNTIMED`; it does not invent timestamps. A compatible custom provider can return real `{ text, start_ms, end_ms }` segments. Untimed but complete transcription is usable, with the location limitation retained.

Unsupported formats request a converter or a readable substitute. Old binary Office formats, PPT/PPTX, video understanding and arbitrary archives have no parser here. Missing dependencies, processors, unreadable content and partial extraction are explicit states, not fabricated success.

### Processing limits

| Boundary              | Limit                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Source file           | 1 byte–25 MiB; included remote ASR upload limit is 25,000,000 bytes                                                |
| Extracted text        | 250,000 characters and at most 10,000 stored segments per parse                                                    |
| PDF                   | 40 pages; split larger brochures before import                                                                     |
| Raster images         | 25 million pixels per frame, 20 frames, 50 million pixels across frames                                            |
| Office ZIP expansion  | 100 MiB total, 3,000 entries, 40 MiB per entry; compression-ratio checks                                           |
| Spreadsheet           | 30 sheets, 10,000 rows per sheet, 256 columns, 100,000 processed cells total                                       |
| Local document worker | 60 seconds, 4 MiB output; individual OCR operations have a 20-second budget                                        |
| Provider              | 90-second default request timeout; configurable from 1 to 120 seconds; 2 MiB response cap                          |
| Semantic extraction   | 20,000-character batches, up to 30 batches; final validation accepts at most 100 facts and 20 questions per source |
| Fact and evidence     | Value up to 2,000 characters; one to eight quotations, each up to 4,000 characters                                 |
| Library reads         | 20-second request timeout, 2 MiB metadata response, 10,000 documents per listing                                   |

Oversized results are rejected with a reason; document tails are not silently discarded. The provider is instructed to return at most 50 facts and 10 questions per batch. Source-wide validation can still require splitting a dense document. The parser does not execute document macros, recalculate formulas or follow document links.

## Install local processors

Use a Node runtime with built-in `node:sqlite`; local acceptance uses Node 24. Python 3.10+ is needed for PDF, Office and image parsing. Plain text does not need Python.

```sh
python3 -m venv .generated/collection-venv
.generated/collection-venv/bin/python -m pip install -r collection/agent/requirements.txt
```

Install Tesseract and the source languages separately. For example, on Debian/Ubuntu:

```sh
sudo apt-get install tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim
tesseract --list-langs
```

Set `ocrLanguage: 'chi_sim+eng'` in the API or `KI_OCR_LANGUAGE=chi_sim+eng` for Chinese/English material. The default is `eng`. Missing Chinese language data is reported as a missing processor; setting the option alone does not install it. Choose a persistent virtual environment for a long-running host.

## Authenticated host API

The following is an integration excerpt. `session`, `config` and `selection` are supplied by the authenticated host. `config.enterpriseLibraryOrigin` must identify the actual running enterprise server, not a fixture service or a document-provided URL. The example explicitly enables all three provider capabilities; use model IDs supported by that provider account.

```js
import { createInformationAgent } from './collection/agent/index.mjs';
import { createEnterpriseLibraryAdapter } from './collection/agent/library.mjs';
import { createOpenAIProvider } from './collection/agent/provider.mjs';
import { createCollectionTools } from './collection/agent/tools.mjs';

const principal = {
  enterpriseId: session.enterpriseId,
  actorId: session.actorId,
};
const library = createEnterpriseLibraryAdapter({
  baseUrl: config.enterpriseLibraryOrigin,
  enterpriseId: principal.enterpriseId,
  headers: { Authorization: `Bearer ${config.enterpriseLibraryToken}` },
});
const provider = createOpenAIProvider({
  apiKey: config.openaiApiKey,
  model: config.semanticModel,
  transcriptionModel: config.transcriptionModel,
  visionModel: config.visionModel,
});
const agent = createInformationAgent({
  databasePath: '/srv/buyersite-private/knowledge.sqlite',
  principal,
  library,
  provider,
  parserOptions: { python: config.pythonExecutable, ocrLanguage: 'chi_sim+eng' },
});
const collectionTools = createCollectionTools(agent);

try {
  const result = await agent.ingestLibraryDocument({
    documentId: selection.documentId,
    version: selection.version,
    entity: { type: 'product', id: 'a12', label: 'A12 fabric' },
  });
  // Return candidate facts, source evidence and questions to the authenticated UI.
  console.log(result);
  // A persistent host can register collectionTools.definitions and .call instead.
} finally {
  agent.close();
}
```

`version` is optional; omission selects the current version and freezes that selection for the read. `ingestAsset(asset, { analyze: false })` also supports trusted host-supplied originals without calling a model. An asset contains `source_id`, `revision`, `enterprise_id`, `entity`, `filename`, `media_type`, `bytes` and optional `sha256`; the host is responsible for its origin and entity assignment. Analysis can follow with `analyzeSource({ source_id, revision, entity })`.

The included OpenAI provider sends extraction text and scoped learning context to `api.openai.com`; enabled transcription and vision send the original recording or image. Model IDs and credentials are explicit configuration. Missing `extract` returns `needs_semantic_provider`; missing parsing capabilities return `needs_material_or_processor`. Extraction can return `analyzed` or `partially_analyzed`; parsing success does not confirm facts. Provider/validation errors record `analysis_failed` and throw without accepting partial candidate output.

### Human review and model tool permissions

Model tools expose only library listing, ingestion, reanalysis, knowledge reads and question retrieval. Their names begin with `enterprise_knowledge_`. They do not expose confirmation, correction, answers, deferral or supplement approval. The host must keep those actions behind authenticated human interactions; the model cannot approve its own output.

Human-facing operations are:

| API                                                                                 | Behavior                                                                                                                |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `reviewFact({ entity, fact_id, action: 'confirm' })`                                | Confirm a candidate after reviewing its source                                                                          |
| `reviewFact({ entity, fact_id, action: 'reject', reason })`                         | Reject an incorrect candidate                                                                                           |
| `reviewFact({ entity, fact_id, action: 'correct', value, reason, request_id })`     | Record a confirmed human correction and retain the prior fact                                                           |
| `reviewFact({ entity, fact_id, action: 'confirm', replace: true, reason })`         | Explicitly resolve a conflict, including by reaffirming the earlier confirmed value                                     |
| `answerQuestion({ entity, question_id, answer, request_id })`                       | Record a human answer as `user-statement` evidence; conflicting replacements need explicit `replace: true` and a reason |
| `deferQuestion({ entity, question_id, reason })` / `resumeField({ entity, field })` | Persist a pause or resume the field                                                                                     |
| `getKnowledge({ entity })` / `audit()`                                              | Read retained facts, provenance, learning context and enterprise-scoped events                                          |

Reuse the same `request_id` when retrying an identical answer. A reused ID with different answer content is rejected. Statements such as `不知道`, `稍后补`, `unknown` or `later` defer the question instead of becoming business facts.

## Facts, questions and learning

Every extracted fact starts as `candidate`, with source ID, immutable revision, SHA-256, parse ID, segment ID, exact quotation, extraction method and location. Quotations must occur in the stored parse. Rejected and superseded facts remain in history. Recognition confidence never promotes a fact to `confirmed`, and a new contradictory candidate never overwrites an existing confirmed value.

Default company goals are `company.display_name` and `company.business_scope`. Product goals are `product.model`, `product.name`, `product.material`, `product.specifications`, `product.moq` and `product.lead_time`. Custom `requirements` may provide scoped fields, labels, priorities, questions, reasons and requested materials. Additional extracted fields are also checked for confirmation and conflicts; the module does not invent absent optional requirements.

`getNextQuestions({ entity, limit: 3 })` returns targeted Chinese questions with reasons, suggested materials, candidate IDs and supporting evidence. Reasons distinguish missing, conflicting, unconfirmed and insufficiently evidenced information, plus incomplete processing and model-identified ambiguity. Conflicts are surfaced first. After ingestion, review or an answer, current gaps are recomputed. Deferred fields stop asking but remain incomplete; no missing material, unresolved conflict or pending source is silently considered ready.

Requirements default to `evidence_required: false`. With `evidence_required: true`, a confirmed human statement alone is insufficient: matching source evidence with a non-`user-statement` method is also required. This is a provenance requirement, not independent certification, authenticity checking or proof that a quoted claim is true. For example, an uploaded specification can support a material claim but does not independently validate a certification body.

“Learning” means persistent, scoped reuse of confirmed facts and human correction examples. The next extraction receives up to 40 confirmed facts, 20 recent applicable correction examples and a bounded list of disputed fields. Candidate, rejected, superseded, stale or conflicting facts do not become confirmed memory; retired correction targets stop teaching obsolete values. Memory can help resolve terminology and aliases within the same entity, but cannot serve as evidence for a new source or erase its contradictions. There is no model fine-tuning, autonomous parameter training or cross-enterprise memory.

### Supplementary material and incomplete sources

For a field gap, import the supporting material for the same entity; questions are automatically recomputed. If a claim already has human confirmation, matching documentary evidence can satisfy a strict evidence requirement. A new unsupported or conflicting value still needs review.

A source-processing question is separate: a readable transcript must not silently be assumed to replace an unreadable recording. First ingest and successfully analyze the supplementary source. Then an authorized human explicitly associates it with the open processing question:

```js
agent.linkSupplement({
  entity: { type: 'product', id: 'a12', label: 'A12 fabric' },
  question_id: selectedProcessingQuestion.id,
  replacement_source_id: transcriptSource.source_id,
  replacement_revision: transcriptSource.revision,
  reason: 'Reviewed this transcript as the usable substitute for the recording.',
});
```

The substitute must be distinct, current, analyzed and linked to the same enterprise/entity. The relationship is audited; it closes the source-processing gap while field questions and factual conflicts remain independently reviewable. Alternatively, install/configure the missing processor and call `analyzeSource` with `reparse: true`. A normal retry reuses the existing parse.

### Immutable revisions and freshness

The same source ID/revision cannot contain different bytes. Repeating an import or parse does not duplicate a fact with the same value and source evidence or reset that fact's review state; a different model interpretation remains a separate candidate. A newly imported current revision retires prior local revisions of that source; facts supported only by inactive revisions become stale and stop satisfying current goals or teaching memory. Original bytes and historical facts remain available for provenance.

“Current” means the library snapshot checked when imported. There is no background sync, library watcher or automatic revocation when the remote document changes, is archived or is reviewed later. The host must explicitly refresh relevant documents before relying on freshness. Importing a historical version does not make it current or analyze it as current knowledge.

## Trusted operator CLI

The CLI accepts one `{ "command": "...", "args": { ... } }` JSON file, up to 256 KiB, and prints JSON. It opens and closes the configured SQLite database for each request. It is an operator interface with human review powers, not a browser upload endpoint or a model tool.

Required environment: `KI_ENTERPRISE_ID`, `KI_ACTOR_ID`, `KI_DATABASE_PATH`. For local files, set `KI_LIBRARY_ROOT` to the authorized source directory; canonical paths and symlinks must stay within it. For server library reads, set `KI_LIBRARY_ORIGIN` to the real enterprise server origin and, where needed, `KI_LIBRARY_TOKEN` to the host-owned bearer capability.

```sh
export KI_ENTERPRISE_ID=enterprise-a
export KI_ACTOR_ID=reviewer-a
export KI_DATABASE_PATH=/srv/buyersite-private/knowledge.sqlite
export KI_LIBRARY_ROOT=/srv/company-library
export KI_PYTHON="$PWD/.generated/collection-venv/bin/python"
export KI_OCR_LANGUAGE=chi_sim+eng
pnpm collection:agent request.json
```

Configure `KI_OPENAI_API_KEY` and `KI_MODEL` together to enable semantic extraction. Add `KI_TRANSCRIPTION_MODEL` for audio and `KI_VISION_MODEL` for image interpretation. Those optional capabilities use the same configured provider; setting their model names without the API key and semantic model does not create a provider. Supply secrets through the host environment, not the request JSON.

Example `request.json` for an original beneath `KI_LIBRARY_ROOT`:

```json
{
  "command": "ingest-file",
  "args": {
    "path": "brochures/a12.pdf",
    "entity": { "type": "product", "id": "a12", "label": "A12 fabric" }
  }
}
```

Local source IDs use `local:<relative-path>`; revisions default to the byte hash unless explicitly supplied. Paths and entity assignments are trusted operator inputs.

| Command                   | `args`                                                  |
| ------------------------- | ------------------------------------------------------- |
| `list-library` / `audit`  | `{}`                                                    |
| `ingest-library`          | `{ documentId, version?, entity }`                      |
| `analyze`                 | `{ source_id, revision, entity, reparse? }`             |
| `knowledge` / `questions` | `{ entity }` / `{ entity, limit? }`                     |
| `review` / `answer`       | Corresponding human-action API arguments above          |
| `defer` / `resume`        | `{ entity, question_id, reason }` / `{ entity, field }` |
| `supplement`              | `linkSupplement` arguments above                        |

Operational errors print a JSON error and return nonzero. A successful command may still report missing processors, unconfirmed facts or `ready: false`; inspect the returned state rather than treating process success as business approval.

## Local acceptance and limits of the evidence

```sh
pnpm test:collection
node --test collection/agent/*.test.mjs
```

The suites exercise real local parsers and SQLite persistence, tenant isolation, immutable evidence, correction reuse after restart, atomic rejection of fake quotes, conflicts, deferrals, supplementary closure and unavailable processors. See [parser fixtures](agent/parse.test.mjs), [agent integration](agent/agent.test.mjs), [core review](agent/core-review.test.mjs), [library adapter](agent/library.test.mjs), [provider](agent/provider.test.mjs) and [CLI](agent/cli.test.mjs).

Semantic extraction and external transports use explicit fixtures/mocks in local acceptance. These tests do not establish live model quality, live speech/vision recognition, or connectivity to an authenticated production enterprise library. Model/account configuration and representative real enterprise material need a separate integration run. No production deployment or site publication is performed by this module or these tests.

## Appendix: website/raw collector compatibility

The earlier [collection/index.mjs](index.mjs) and [collection/cli.mjs](cli.mjs) retain explicit public HTTPS capture and operator-provided raw file bundles for existing site-builder workflows. They are compatibility utilities, not the phase-one internal knowledge agent. Their raw bundle preservation does not provide the parsing, confirmation, persistent memory or questioning described above.

`pnpm collection:run request.json .generated/collection/bundle.json` retains the earlier `{ authorized, enterprise_id, website_urls, documents }` request contract. `projectWebsitePages` checks the bundle and projects same-company snapshots into the existing builder format. The site-builder facade and its commands remain compatible. Only the approved snapshot projection belongs in a site build; the agent database, recordings, raw source bytes, private questions and whole raw bundles must remain outside published site content.
