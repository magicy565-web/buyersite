# Dual-path media and AI visual review — private enterprise editions

This change is stacked on `feat/editorial-visual-director-v1`. It is a **private, source-bound Site Worker implementation**, NOT an automatic publishing feature. No model or media service credentials are committed.

## Two mutually exclusive paths per article

1. **Licensed photography**: An authenticated enterprise snapshot may include `mediaAssets` referencing immutable `<sha256>.bin` files under `BUYERSITE_MEDIA_ROOT/<enterprise-id>/`. The Worker uses the image only if the frozen asset descriptor has explicit `approved-public` rights with a grant SHA-256, approver identity, approval date, nonexpired scope and crop/resize permission. The file must be regular (no symlink), be within the correct tenant, match the supplied hash, be bounded and be valid PNG/JPEG/WebP with usable dimensions. The builder never downloads arbitrary supplier-image URLs. The importer is **operator-only** and requires the rights grant file and an explicit rights/crop attestation. Grant metadata does **not** substitute for a legal verification of the rights document.
2. **No usable licensed image**: With frozen `mediaGenerationAuthorized: true` on the server snapshot, `job.input.allowAiGeneration: true`, and a server-only `OPENAI_API_KEY`, the Worker calls the GPT Image 2 Images endpoint. Generated pictures are editorial concepts, never described as actual products or factories. Images carry model + prompt digest + output SHA in `media-report.json`. Without that dual authorization or credentials, the original abstract artwork remains as a clearly labelled **fallback**, not falsely described as an AI-generated photo. Failed provider requests fail the build instead of being misrepresented as approved imagery. By default, a job can generate at most four images (six is the hard cap; budgets must be set operationally).

Every final image is bound to its article's ID and its file hash. The `media-plan.json` contains source decisions; `media-report.json` contains actual rendered outcomes. The former is part of the immutable content fingerprint, and the latter of the byte-verified build artifact.

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

The CLI returns a descriptor; the authenticated OpenMausBot export must attach it to the **frozen snapshot** as `mediaAssets: [descriptor]`. Approved photos are not selected merely because a buyer supplies an internet URL. Rights must still be reviewed at the final publication decision.

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

After `astro check`, `astro build` and verified output, the Worker takes real full-page screenshots (1440px desktop and 390px mobile) from a temporary **loopback-only** HTTP server. It reviews up to three real pages: home, first product and first supplier. The screenshots, source media kind and page context are sent to the multimodal Responses API with `store:false`, a strict JSON output schema and a critical art-director prompt, **only when** both source and job consent to external AI review and the API key is configured.

- Output is `PENDING_CONFIGURATION`, `REVIEW_ERROR`, `REVISION_REQUIRED`, or `PASS_RECOMMENDED`.
- `PASS_RECOMMENDED` requires all four 1–5 scores ≥4, model decision `pass`, no major/critical issues, and successful real screenshots.
- Failed or unavailable AI review never claims PASS. All outcomes have `publication: BLOCKED` and `human_approval_required: true`.
- The review is bound to the exact static artifact SHA and saved outside the public artifact tree at `<worker-data>/<job-id>/visual-review.json`; screenshots are private under `visual-review/screenshots`.
- Authenticated same-enterprise bridge endpoints:
  - `GET /api/magazines/site-jobs/:id/visual-review` (report)
  - `GET /api/magazines/site-jobs/:id/visual-review/screenshot/:filename` (hash-verified PNG)
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

Synthetic unit tests inject a fake image generator and fake vision assessor; **they are not evidence of actual paid API calls**. Full live review requires server-secret credentials, explicit enterprise consent, a real Chromium binary and authorized non-synthetic source media. Never use a synthetic vision pass as publication approval.

## Remaining integration

OpenMausBot's native company/product source snapshot, photo approval UI, and account-scoped grant ledger must emit these fields and populate the private registry. Without this host change, the standalone builder supports the two paths, but the normal Studio button does not yet automatically ingest approved images. No production site is deployed.
