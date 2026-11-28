# Collection: long real-world PDF smoke test

The prior parser rejected any PDF over 40 pages. It now accepts up to 80,
preserves original viewer-page locators, limits cumulative processing, and
explicitly identifies pages skipped by the OCR resource budget. Other document
budgets and the published-site release gate were not changed.

A real 58-page, 13,901,885-byte, image-only pilot catalogue was run through the
trusted operator CLI on a private local SQLite database with Tesseract
`chi_sim+eng`. It returned 58 page-linked segments in approximately 67
seconds. A manual spot-check found the expected model identifiers on pages
32 and 45. This is a parsing smoke test, not a measured OCR accuracy result.
The Chinese OCR data came from the official `tessdata_fast` repository at
`87416418657359cb625c412a48b6e1d6d41c29bd`. The source, extracted content and
database were not committed, uploaded or sent to a model provider.

The CLI correctly returned `needs_semantic_provider`. Live authenticated
library reads, real transcription/vision/semantic extraction, and host access
controls and rollback still require the [private pilot gates](../../collection/PILOT-READINESS.md).
The upstream library's 12 MiB limit is unchanged; this representative file was
read as a trusted local original, not accepted through the live library.

Automated regressions cover an 81-page rejection, a synthetic 58-page
contract with original page numbering in a text-layer fixture, and OCR budget
exhaustion retaining available embedded text without calling the result ready.
