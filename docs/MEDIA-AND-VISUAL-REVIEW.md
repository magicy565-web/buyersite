# Two media paths and the AI review release gate

The public editorial pilot and private enterprise builder share the same media policy and review binding. No new media platform, supplier messaging system or public enterprise publishing endpoint is introduced. The public pilot uses three original, clearly disclosed ChatGPT-generated concept illustrations. Its actual image reviews are interactive AI observations; this does not claim an Images API or Responses API call occurred.

## One decision per page

| Available evidence | Image choice | Release requirements |
| --- | --- | --- |
| An explicit, applicable and current commercial grant covers a retained image | Use that licensed image | Original image and grant bytes, current tenant rights record, page scope, transformation permission, nonexpired/nonrevoked grant, exact rendered derivation, and completed AI review |
| No usable licensed image | Generate an original concept when generation is authorized | Retained prompt/model/provider and image hashes, truthful visible concept caption/credit, completed AI image/page review, and separate publication checks |
| Generation or review cannot run | Keep a clearly labelled abstract preview or return a review/configuration error | Public release remains blocked; an abstract fallback is not an approved AI concept |

A photograph may be reused on multiple explicitly covered pages. The quality report records repetition without treating it as a rights failure. A public website URL, supplier identity or image caption does not confer commercial image rights.

## Commercially authorized images

The trusted importer requires the actual grant document and separate explicit attestations for commercial use and transformations. The authenticated caller must verify that the document covers the tenant, page and intended use. The software verifies the supplied authorization record; it cannot infer a valid grant from a filename or hash.

```bash
node site-builder/media-import.mjs \
  /srv/buyersite/private-media \
  enterprise-01 product-slug asset-01 \
  /private/approved-photo.jpg /private/signed-grant.pdf \
  'Cotton fabric closeup' 'Photo: Supplier, used with permission' \
  editor-01 --attest-commercial-rights-and-transforms \
  --expires-at 2027-01-01T00:00:00Z
```

The returned descriptor includes `rights.enterprise_id`, explicit `page_ids`, `allow_commercial`, `allow_resize`, `allow_crop`, grant SHA, grantor, approval time and expiry. The API equivalent requires both `attestRights: true` and `attestCommercialUse: true`. Old descriptors without explicit commercial and page/tenant scope are not approved; an authorized new import is required.

Private storage contains the immutable original image at `<tenant>/<image-sha256>.bin`, grant at `<tenant>/grants/<grant-sha256>.bin`, and current descriptor at `<tenant>/rights/<asset-id>.json`. Asset IDs identify immutable imported approvals; a revised approval uses a new asset ID. The private source snapshot alone is insufficient: render, validation and release read the current registry and compare the exact rights fingerprint. Files must be regular, bounded and hash-correct within the expected tenant. The published image must be the authorized original or the deterministic supported crop/resize of that original; attaching another image to a valid grant fails.

Withdraw a grant for every use in that tenant with the operator-only operation:

```bash
node site-builder/media-import.mjs --revoke-grant \
  /srv/buyersite/private-media enterprise-01 \
  <grant-sha256> editor-01 'Grant withdrawn by rights holder'
```

This writes a retained revocation marker. Frozen approvals, cached images and re-import attempts cannot override it. A damaged marker also blocks use. Restoring permission requires a new evidenced grant, not deleting the marker. Expiry is evaluated at render/build/release time, not only at the original snapshot date. A grant withdrawal after a static site has already deployed requires the operator to remove/rebuild that deployed content; this implementation does not run a background takedown service.

The authenticated OpenMausBot host must attach imported descriptors as `mediaAssets` and populate the private registry. Native production ingestion remains a host integration dependency; synthetic fixtures are not real supplier permission.

## Generation when no licensed image is usable

The enterprise builder requires both server-snapshot `mediaGenerationAuthorized: true` and job `allowAiGeneration: true`, plus a server-only `OPENAI_API_KEY`. Existing server/image adapter configuration is retained: `BUYERSITE_IMAGE_MODEL` chooses an explicitly supported model and `BUYERSITE_VISION_MODEL` chooses the vision model. No automatic model or cost upgrade occurs. The default per-edition generation limit is four; the hard cap is six.

Generated output is a concept, never evidence of a real product, factory, certificate or commercial specification. The report retains the actual prompt and prompt digest, model, provider and normalized image digest. Cached retries bind tenant, page, prompt, model, dimensions, quality and normalization policy; corrupt bytes or receipts fail closed without a silent replacement charge. Failed provider calls do not become successful fallback approvals. Provider responses are bounded before JSON parsing and safe errors exclude credentials and response bodies.

The current public pilot's three originals came from the built-in ChatGPT image generator. Their provider/model metadata truthfully states that the built-in tool did not expose an API model identifier. They were visually inspected again in ChatGPT before the current bound image-review receipts were recorded. No paid provider credentials were configured or paid provider requests executed during that verification.

## One review binding, two real review methods

`site-builder/media-review.mjs` binds the exact image SHA, prompt SHA, generation provider/model, rights provenance, page ID, URL, title, alt text, credit and caption. The policy version is part of the digest. Changing any of these invalidates the old image approval even if someone updates the registry's image hash. Full-page source and artifact binding separately catch layout/content changes.

Accepted image review methods are `interactive-vision` and `openai-responses`. Both require an actual AI observation, a stored assessment with no blocking findings and scores of at least four out of five. There is **no mandatory human approval** after a valid AI review. Legal authorization, source-evidence publication permission, conversion readiness and deployment eligibility remain separate checks.

An interactive AI reviewer must open the actual original image, assess it in the intended page context and record the observation using `mediaReviewReceipt`. This helper only binds and formats the supplied assessment; it does not inspect an image or invent a verdict. The pilot registry retains its earlier review notes alongside the new bound observations. Automated image review uses `reviewMediaAsset` in the existing visual-review adapter, supplying the actual pixels and intended caption/context through the Responses API. Provider success without a complete valid assessment cannot pass.

Injected transports/captures/assessors are marked `evidence_type: fixture`. Tests can exercise the contract, but those results cannot satisfy a real release gate. Review status alone is insufficient; missing, rejected, stale or fixture reviews block public preparation. A stored hash is an integrity check, not a cryptographic attestation of a reviewer: only trusted server/operator workflows may write approvals. Untrusted inputs must never be allowed to submit their own approval receipt.

### Default editorial site

The existing `src/data/concept-media.json` registry now supports either `ai-generated` or `licensed-photo` for each pilot article; it retains its filename for compatibility. `scripts/prepare-media.mjs` verifies complete article coverage, original pixels, matching frontmatter disclosure and bound observed AI image review. Licensed entries additionally require the current private registry and a valid authorized image derivation.

`assertPublicRelease` repeats that check. The final release report must match the current source fingerprint, which includes the shared media policy code, and actual page review must cover home, all articles, enquiry, search, sources, colophon and privacy. Image approval does not substitute for this page review. There is no skip-approval environment flag.

### Enterprise editions

The Worker keeps enterprise artifacts private. With both `aiReviewAuthorized: true` in its server-owned snapshot and `allowAiReview: true` in the job, the existing review adapter captures every manifest page at 1440px desktop and 390px mobile. It loads/decode-checks lazy images and fonts, detects overflow, and divides long pages into readable overlapping segments. Every segment goes to the authorized reviewer; oversized or incomplete coverage cannot pass.

Receipts bind the complete artifact digest plus source-page/media-plan/rights/image/prompt bindings. `PASS_RECOMMENDED` requires the model's pass decision, all four page scores at least four and no major/critical issues. `assertEditionVisualReview` revalidates current image/grant data, full coverage, assessment and screenshot hashes before a future publisher can consume that recommendation. It accepts observed automated or interactive AI reviews; it does not lift enterprise privacy. All current enterprise reports retain `publication: BLOCKED` with `ENTERPRISE_PRIVATE_PREVIEW`, and `human_approval_required: false`.

Private authenticated review endpoints are unchanged:

- `GET /site-jobs/:id/visual-review`
- `GET /site-jobs/:id/visual-review/screenshot/:filename`

Screenshot names are `<page>-desktop.png` or `<page>-mobile.png`, followed by `-2` through `-12` when needed. Reports and grant documents stay outside the public artifact. Cross-tenant access remains blocked.

## Verification and limits

```bash
node --test site-builder/media-policy.test.mjs site-builder/media-import.test.mjs \
  site-builder/media-render.test.mjs site-builder/media-review.test.mjs \
  site-builder/visual-review.test.mjs
node scripts/prepare-media.mjs
```

The targeted suite uses real Node filesystem, cryptographic hashes, Sharp decoding/normalization and streamed-response handling. It tests expired/revoked/wrong-scope grants, explicit commercial attestation, missing/current records, source and grant tampering, source-to-output derivation, changed prompt/model/page/disclosure, missing/rejected/fixture review, safe fallback, cache corruption, readable all-page capture segmentation and provider response validation. Authored colored images, test grant documents and injected provider assessments are clearly synthetic. They do not prove production API account access or real supplier permission.

Live evidence in this turn is the three original concept files and their actual interactive AI image inspection. Final browser/page acceptance and the source-bound release report are performed separately on the built artifact. No new paid provider execution is claimed.
