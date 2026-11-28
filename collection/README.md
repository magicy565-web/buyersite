# Information collection / 信息采集 v0.1

Independent, server-side source intake. No Astro, model API, rendering, marketing, public routes or buyer enquiry dependencies. This is phase one of the Buyersite refactor; later extraction and publication are separate.

## Supported sources

- Explicit public HTTPS URLs (up to five per batch). No recursive crawling, browser rendering, search-engine scraping or login bypass. Same-domain redirects only; robots, DNS/IP pinning, response limits and timeout are enforced. Static HTML text and original response bytes are retained, with separate SHA-256 hashes.
- Operator-provided original files and existing enterprise/dataset exports (up to eight; 2 MB each, 8 MB total). UTF-8 TXT/Markdown/CSV and JSON retain text and bytes; JSON is checked for syntactic validity. Other formats, including PDF, Office, images and video, are preserved as opaque bytes only. Declared MIME types are not verified. No PDF/OCR/Office parsing, schema extraction, transcription or fact inference yet.
- Stable source IDs within an enterprise, captured/failed receipts, content hashes, timestamps, private-only bundle, and complete/partial/failed batch outcome. Same input source identities deduplicate within one job; hashes permit later content comparison. This is not a persistent global deduplication database.

## Operator CLI

Use a trusted local operator or upstream authenticated server. The authorization flag records consent to collect; it is not authentication. Never expose the CLI or the library directly as a browser upload or URL proxy.

Example request.json (synthetic addresses and local paths; replace with authorized inputs):

```json
{
  "authorized": true,
  "enterprise_id": "example-enterprise",
  "website_urls": ["https://example.com/"],
  "documents": [
    {"path": "./catalog.csv", "media_type": "text/csv", "source_kind": "operator-upload"},
    {"path": "./profile.json", "media_type": "application/json", "source_kind": "enterprise-export"}
  ]
}
```

```sh
pnpm collection:run request.json .generated/collection/bundle.json
pnpm test:collection
```

The CLI refuses overwriting, writes a private JSON bundle beneath the existing ignored .generated directory, and returns nonzero on partial or failed collection even when a receipt was written. Protect the bundle; never commit, render, execute, or publish its raw contents. Avoid storing secrets or collecting private personal information without authorization. The CLI is for trusted local operators, not arbitrary file paths submitted by visitors.

## Library / handoff

Import collectSources from collection/index.mjs. Pass authorized, server-owned enterprise_id, website_urls, and optional documents with Buffer bytes, name, media_type, source_kind (operator-upload / enterprise-export / dataset-export) and optional source_ref. The returned records preserve raw originals. Every captured record is unverified, regardless of source type.

projectWebsitePages(bundle, {enterprise_id, company_website}) rejects a partial/failed bundle or tenant mismatch, checks hashes and returns only same-company website snapshots in the existing builder format. The site-builder capture module remains a compatibility facade; existing enterprise-to-site commands retain their behavior. For independent collection, pass the projected website_pages into the existing site:from-snapshots request together with the authenticated enterprise export and its approved media. Do not pass raw document bytes or the whole collection into a website build. Explicit review, fact extraction, rights approval and publication remain downstream.

## Acceptance

Test multi-source capture, provenance and raw integrity, private data boundary, unchanged legacy snapshot shape, invalid/duplicate inputs, blocked websites and partial receipts, foreign tenant isolation, domain checks, oversized input. Existing site-builder test glob also imports the collection tests without modifying managed workflows. Real site acceptance and live native-library connectivity are separate and must not be inferred from synthetic tests.
