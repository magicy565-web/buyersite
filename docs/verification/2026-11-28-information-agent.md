# Internal information acquisition agent verification

Date: 2026-11-28 (Asia/Shanghai).

Scope: phase one of the Buyersite refactor, corrected to internal multimodal knowledge acquisition, confirmed learning memory, targeted questions and supplementary material. This is a source-module verification record, not a production or publication approval.

## Implemented flow

1. Bind the host-authenticated enterprise, actor and target company/product.
2. Read an exact internal library document version or trusted local original.
3. Preserve original bytes, SHA-256 and immutable revision in private SQLite storage.
4. Parse actual text, PDF, DOCX, XLSX, images or configured audio transcription into located segments.
5. Supply confirmed entity memory and correction examples to semantic extraction.
6. Validate exact quotations and create candidate facts, without allowing the model to confirm them.
7. Ask for missing, contradictory, unconfirmed or inadequately sourced information.
8. Persist human answers, reviews, corrections and explicit supplementary-source relationships.
9. Recompute outstanding questions and reuse applicable confirmed memory on the next extraction.

The module exposes a host API, trusted operator CLI and atomic tool definitions. It does not install itself into a running OpenMausBot instance or provide a new browser UI.

## Observed checks

Environment: Node 24.22.3; pnpm 11.25.0; Python 3.12; PyMuPDF, python-docx, openpyxl, Pillow and local Tesseract available. The installed OCR languages were `eng` and `osd`.

| Check                                                                                    | Observed result                                                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`                                                         | Passed; existing lockfile used                                                                                                        |
| `pnpm test:collection`                                                                   | 94 passed, 0 failed, 0 skipped                                                                                                        |
| `pnpm test:site-builder`                                                                 | 43 passed, 0 failed, 0 skipped                                                                                                        |
| `pnpm exec eslint collection/agent/*.mjs`                                                | Passed                                                                                                                                |
| `pnpm check`                                                                             | 0 errors, 0 warnings, 3 pre-existing unused-parameter hints                                                                           |
| Default `pnpm build`                                                                     | Blocked by `PUBLIC_RELEASE_REVIEW_STALE`                                                                                              |
| `pnpm accept:site-builder --static-only site-builder/fixtures/enterprise.synthetic.json` | `STATIC_PASS_BROWSER_NOT_TESTED`; unit checks, durable Worker acceptance, private edition check, build and output verification passed |

The collection suite consists of 13 agent integration tests, 12 independent core review tests, 13 goal/memory tests, 20 library adapter tests including nested cases, 16 parser tests, 9 provider contract tests, 5 CLI/tool boundary tests and 6 legacy collector compatibility tests.

The final focused integration rerun after formatting also passed all 25 agent/core-review tests. Browser visual review was not run; this change does not modify site layout or colors.

### Real local execution

- Real generated text PDF, scanned PDF, mixed PDF, DOCX, XLSX and PNG bytes are parsed. OCR assertions verify actual extracted label text and page/image locations.
- Complete text ingestion, human correction, database close/reopen, subsequent memory reuse, supplementary answers and readiness transitions execute against actual SQLite files.
- Independent review tests exercise out-of-order source revisions, historical source retirement, tenant and entity isolation, immutable evidence, full transaction rollback and private database permissions.
- Supplement tests verify that a separately uploaded transcript does not silently replace an unprocessed recording. An explicit human link closes only the source-processing question. Facts remain candidates until reviewed, and retiring the pinned supplement revision reopens the source question.
- Parser tests cover unavailable languages/processors, malformed documents, unsupported DOCX body blocks, missing spreadsheet formula caches, ZIP expansion, image size and PDF page limits.

### Explicitly mocked or not tested

- Semantic model output, remote ASR, remote vision and authenticated library HTTP responses use explicit test fixtures/mocks. Tests validate the transport and business contracts, not live recognition quality.
- No production enterprise library session, real enterprise document or production model credential was used.
- There is no verified live transcription/vision/semantic model deployment, Chinese OCR recognition run, production registration, site publication or background library synchronization in this result.
- The included audio adapter accepts complete untimed transcription as whole-recording evidence with a warning; it does not fabricate timestamps.
- PDF embedded image meaning, complex Office layout and unsupported formats can remain incomplete with explicit warnings. These are not claimed as fully understood.

## Public build gate

The public build checks the exact source fingerprint against its existing editorial release report. The retained report is already stale on the incoming branch commit, before this corrective implementation:

| Baseline item                   | Value                                                              |
| ------------------------------- | ------------------------------------------------------------------ |
| Incoming commit                 | `a0be0442f2cacc88a9ff38752d765ae7b8486f3b`                         |
| Publication mode                | `public`                                                           |
| Baseline calculated fingerprint | `ee5060ee96a8d98ebdf4b161993c47dc2024b4e43270fda56e5fa0567383fb4b` |
| Retained approved fingerprint   | `76fdf7b32ede89a993d33e28c57b2e3c759d6d8fbf8289646035ac2a51c97272` |

The baseline fingerprint was recomputed from Git objects at that commit using the same file selection and normalized publication settings as `scripts/release-gate.mjs`. No release report, publication mode, gate or managed workflow was changed to obtain a pass.

The repository's existing private-edition acceptance path successfully built the synthetic edition. Its retained artifact inventory contains 88 files and SHA-256 `2d2e55b61567055b79cd89d22af64d5ec5bdab9e7b0bc32b24f125e1ba13ccc5`. The local run record is `.generated/acceptance/2026-11-28T03-36-58-127Z/report.json` and is intentionally excluded from Git along with generated site assets.

## Source and service contracts

The library adapter follows the existing enterprise-library source contract audited in `magicy565-web/openmausbot-worker` at commit `a85980381a01854412c9bc60fcbf572a4e88cff5`, under `workspace/openmausbot-worker/integrations/openmaus-enterprise` and `enterprise-library`. This confirms a repository contract, not current production availability. Its upstream attachment upload limit remains 12 MiB; the new adapter's 25 MiB defensive read limit does not change that upstream limit.

The optional model provider implements the primary documented [Responses structured output](https://developers.openai.com/api/docs/guides/structured-outputs) and [file transcription](https://developers.openai.com/api/docs/guides/speech-to-text) contracts. The host chooses supported model IDs and credentials; there is no implicit model selection or hidden production call.

Deployment integration requires a persistent private database directory, the authenticated enterprise transport, installed document/OCR dependencies and explicit semantic/ASR/vision provider configuration. Human confirmation and correction must remain authenticated host actions, separate from the extraction model's tools. See [collection/README.md](../../collection/README.md) for the concrete API and CLI integration contract.
