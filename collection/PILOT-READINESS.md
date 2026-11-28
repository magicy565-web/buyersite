# Internal pilot acceptance

This module extracts information for internal review. A green parser test,
a draft PR, or a successful build is not a deployment or permission to
publish enterprise records. No public site changes are required for the
first trusted-operator pilot.

## Staging gates

1. Register on an authenticated staging host with the pilot enterprise and
   an explicit user/role policy for each selected product or company.
   Model tools may extract and read; only authenticated human reviewers may
   confirm or correct. Exercise the real entry point as two identities.
   Refuse a cross-tenant read or write and a model-originated review; verify
   the denied requests leave no state.
2. Verify real library access on that host with a least-privilege credential.
   Ingest one exact authorized document version and compare its byte count,
   SHA-256 and original locator to the library. Revoke access, then verify
   a fresh read fails. Recheck remote freshness before treating a retained
   version as current. Do not raise the upstream library limit here.
3. Check local dependencies and run a Chinese and English scan. Start with
   an attachment accepted by the library, then repeat using a long document
   through the trusted local original path if the upstream limit is smaller.
   Independently compare a sample of page references, numbers and model
   identifiers. Treat OCR as candidate text even when parsing returns ready.
4. With a documented data-processing approval and explicitly configured
   provider, use a permitted pilot audio file, image and text extract.
   Confirm data sent matches the approved scope, partial recognition is
   disclosed, and unavailable or timed-out providers do not create facts.
   No production assets should be sent through a developer smoke test.
5. In the UI or operator flow: import, inspect a fact's exact source,
   resolve a real conflict, answer or attach one missing item, restart the
   host and verify that a correction is reused without becoming evidence
   for a different file or entity. A model 'confidence' value must not
   approve a fact.
6. Prove restart and rollback on a private persistent volume. Restrict
   database, WAL, backups, logs and exports to authorized operators. Test
   restore from a consistent SQLite backup. Disable the staging integration
   to stop ingress without erasing originals or audit history. Establish
   deletion/retention rules, access logging, resource limits and error alerts.

## Release decision

Record the repository SHA, environment, test identifiers, actual outcomes
and a named operator for rollback. Mark missing permissions, providers or
live test evidence as blocked; never mark those gates passed from mocks.
Keep the public-site source review and existing managed CI untouched.

### Provider deadline and data scope

The built-in provider applies a single semantic extraction deadline across all
batches (120 seconds by default, configurable by the host within 1–180
seconds), in addition to its per-request timeout. A stalled later batch must
not write earlier candidates; originals remain available for retry. This
deadline does not cover library access, OCR, transcription or the ingress
proxy. Before enabling the host route, test a delayed multibatch request and
a disconnect through the actual proxy and verify retry behavior. Do not
assume that a client-side abort cancels work already received upstream.

For approval of outbound fields, separately inventory source text, filenames,
entity and version identifiers, confirmed facts and examples of human
corrections sent with semantic extraction, and original file bytes sent to
vision or audio services. Confirm actual provider-project retention settings;
a request with response storage disabled does not establish zero retention.
Use synthetic pilot files until that scope is approved.
