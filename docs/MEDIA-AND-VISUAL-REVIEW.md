# Dual-path media and AI visual review — private enterprise editions

This change is stacked on `feat/editorial-visual-director-v1`. It is a **private, source-bound Site Worker implementation**, NOT an automatic publishing feature. No model or media service credentials are committed.

## Two mutually exclusive paths per article

1. **Licensed photography**: An authenticated enterprise snapshot may include `mediaAssets` referencing immutable `<sha256>.bin` files under `BUYERSITE_MEDIA_ROOT/<enterprise-id>/`. The Worker uses the image only if the frozen asset descriptor has explicit `approved-public` rights with a grant SHA-256, approver identity, approval date, nonexpired scope and crop/resize permission. The file must be regular (no symlink), be within the correct tenant, match the supplied hash, be bounded and be valid PNG/JPEG/WebP with usable dimensions. The builder never downloads arbitrary supplier-image URLs. The importer is **operator-only** and requires the rights grant file and an explicit rights/crop attestation. Grant metadata does **not** substitute for a legal verification of the rights document.
2. **No usable licensed image**: With frozen `mediaGenerationAuthorized: true` on the server snapshot, `job.input.allowAiGeneration: true`, and a server-only `OPENAI_API_KEY`, the Worker calls the Images API. The existing `gpt-image-2` default is retained; an operator can choose another explicitly supported model through `BUYERSITE_IMAGE_MODEL`. There is no automatic model or cost upgrade. Generated pictures are editorial concepts, never described as actual products or factories. Images carry model + prompt digest + output SHA in `media-report.json`. Without that dual authorization or credentials, the original abstract artwork remains as a clearly labelled **fallback**, not falsely described as an AI-generated photo. Failed provider requests fail the build instead of being misrepresented as approved imagery. By default, an edition contains at most four generated images (six is the hard cap; budgets must be set operationally).

Every final image is bound to its article's ID and its file hash. The `media-plan.json` contains source decisions; `media-report.json` contains actual rendered outcomes in the private source directory. The content validator recomputes the plan digest and verifies image bytes and the exact planned source/grant/asset/credit bindings. The static artifact inventory independently hashes the final public image bytes; private rights metadata is not copied into the public output.

An explicitly authorized photograph can appear on several explicitly bound pages. The report records `REUSED_IMAGE` as an editorial quality warning rather than discarding a usable licensed image. Rights are checked again at render and build time.

### Retry and provider integrity

Generated PNGs and small receipts are cached in the private source directory's `.media-cache` (or an operator-supplied `mediaCacheDir`). The cache key binds tenant, page, full prompt digest, model, requested dimensions, quality, output format and normalization version. Identical retries reuse the validated bytes and make no provider call. A corrupt/missing cached image with an existing receipt fails closed; it does not silently spend again. Changing a model, prompt or policy requires a new build identity. Cache hit/call counters are execution diagnostics, not approval evidence.

Both API adapters bound streamed response bytes before JSON parsing. Generated images must decode as usable still PNGs; claimed prompt/model/output receipts must match the actual request and image. API errors expose only safe error codes, never provider response bodies or credentials.

The request shape and explicit model list were checked against the [official Images API reference](https://developers.openai.com/api/reference/resources/images/methods/generate) on 2026-11-18. Availability for a particular API account still requires a live authorized call; mocked tests do not prove account access.

### Rights importer (trusted operator; not a public form)

```bash
# Grant document must actually authorize publication and transformations;
# the CLI cannot determine legality from a hash.
node site-builder/media-import.mjs \
  /srv/buyersite/private-media \
  enterprise-01 product-slug asset-01 \
  /private/approved-photo.jpg /private/signed-grant.pdf \
  'Cotton fabric closeup' 'Photo: Supplier, used with permission' \
  editor-01 --attest-rights-and-transforms
```

The CLI returns a descriptor; the authenticated OpenMausBot export must attach it to the **frozen snapshot** as `mediaAssets: [descriptor]`. Add `--expires-at <ISO-timestamp>` when the grant expires; invalid or already expired grants cannot be imported. The importer retains the original grant privately at `<media-root>/<enterprise-id>/grants/<grant-sha256>.bin`. Rendering verifies these bytes as well as the image, and fails if either is missing, replaced or linked. The grant is never added to the public site. Approved photos are not selected merely because a buyer supplies an internet URL. Rights must still be reviewed at the final publication decision.

### Studio snapshot and job flags

```json
{
  "mediaUsageAuthorized": true,
  "mediaAssets": ["<operator-created immutable descriptors>"],
  "mediaGenerationAuthorized": true,
  "aiReviewAuthorized": true
}
```

```json
{
  "job": {
    "input": {
      "allowApprovedMedia": true,
      "allowAiGeneration": true,
      "allowAiReview": true
    }
  }
}
```

Both the *server-owned* snapshot and the Studio job must grant the respective action. Unknown images remain excluded. Do not place images, API keys, rights contracts, or credentials in browser forms.

## Visual AI review

After `astro check`, `astro build` and verified output, the Worker captures every page in the generated manifest, including home, all products, supplier and buying guide. The default limit is 16 pages; exceeding the configured budget fails the review instead of silently skipping pages. Empty manifests, unsafe paths and missing image bindings cannot pass.

Real screenshots use 1440px desktop and 390px mobile on a temporary **loopback-only** HTTP server. Capture triggers lazy images, waits for successful image decoding and fonts, and checks overflow. Long pages are divided into overlapping 1600px-high segments; mobile text remains at its original pixel width. The reviewer receives every segment, not a vertically compressed whole-page thumbnail. There are at most 12 segments per viewport; a larger page requires correction or a deliberate budget change and cannot receive a partial PASS.

The screenshots, source media kind and page context are sent to the multimodal Responses API with `store:false`, a strict JSON output schema and a critical art-director prompt, **only when** both source and job consent to external AI review and the API key is configured.

- Output is `PENDING_CONFIGURATION`, `REVIEW_ERROR`, `REVISION_REQUIRED`, or `PASS_RECOMMENDED`.
- `PASS_RECOMMENDED` requires all four 1–5 scores ≥4, model decision `pass`, no major/critical issues, and successful real screenshots.
- Failed or unavailable AI review never claims PASS. All outcomes have `publication: BLOCKED` and `human_approval_required: true`.
- The review is bound to the exact static artifact SHA and saved outside the public artifact tree at `<worker-data>/<job-id>/visual-review.json`; screenshots are private under `visual-review/screenshots`.
- Authenticated same-enterprise Worker endpoints (the host may add its own proxy prefix):
  - `GET /site-jobs/:id/visual-review` (report)
  - `GET /site-jobs/:id/visual-review/screenshot/:filename` (hash-verified PNG)
- First screenshot filenames are `<page>-desktop.png` and `<page>-mobile.png`; subsequent segments append `-2` through `-12`. Each report entry records viewport, vertical position, dimensions and byte digest.
- Cross-tenant access remains 404. There is still no `publish` endpoint; human review, actual media rights, real RFQ and production deployment verification are separate required gates.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm test:site-builder
pnpm check:editorial
pnpm accept:site-builder --static-only
# With Playwright Chromium available:
pnpm accept:site-builder
```

Synthetic unit tests inject a fake image generator and fake vision assessor; **they are not evidence of actual paid API calls or real browser screenshots**. They exercise real Node filesystem, crypto, streamed Response bodies and Sharp image operations. Coverage includes tenant isolation, authorization, cached retry/corruption, receipt binding, all-page review, readable tall mobile segmentation and malformed review rejection. Full live review requires server-secret credentials, explicit enterprise consent, a real Chromium binary and authorized non-synthetic source media. Never use a synthetic vision pass as publication approval.

## Remaining integration

OpenMausBot's native company/product source snapshot, photo approval UI, and account-scoped grant ledger must emit these fields and populate the private registry. Without this host change, the standalone builder supports the two paths, but the normal Studio button does not yet automatically ingest approved images. No production site is deployed.
