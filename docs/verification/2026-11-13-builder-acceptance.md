# BuyerSite builder verification — 2026-11-13

Historical checkpoint: the browser blocker below was subsequently resolved.
See [the later browser acceptance](2026-11-13-browser-acceptance.md) for current status.

## Result

**Static checks pass; full builder acceptance remains blocked by browser launch.**
No live enterprise export, live website capture, OpenMausBot integration,
protected server preview, production deployment or publication was performed.
All three inputs are explicitly synthetic software fixtures.

Tested local implementation commit: `2b28883c2d30e4f987c4d5fae68f95da6f2857a3`.
Published equivalent implementation commit: `601c609e30bcc2cb4041ce389fa27c6804bd292d`.
The GitHub-created implementation tree was verified identical to the tested
local tree: `57c3a641022b05ebf442a23da421021e1028b59d`. The tested checkout was
clean. The following verification-document commit changes this report only.

Runtime: Linux x64, Node `v24.22.1`, pnpm `11.25.0`, Astro `7.3.3`,
Playwright `1.65.0`. Dependencies were installed with `--frozen-lockfile`;
`pnpm-lock.yaml` was not changed. The configured pnpm version is `10.34.5`;
this executor supplied `11.25.0`, so an exact-pnpm-10 reproduction is NOT_TESTED.

## Actual defect and repair

The unmodified PR #2 failed `pnpm build` while generating optimized images:
Astro rejects SVG rasterization by default. The builder and default share-card
asset now use PNG rasterized from repository-owned constant artwork with Sharp.
The artwork remains labeled as an original illustration, not a supplier photo.
Astro's processing of arbitrary SVG uploads was not enabled.

Browser tests formerly hardcoded the Burel pilot's routes and old enquiry
labels/filename. They now derive all routes from the selected static output,
check company-specific H1/evidence, all images, noindex, a disabled assistant,
unsent enquiry downloads and deep-link navigation at 1440px, 390px and 360px.
Astro 7 agent-mode preview detachment is prevented with `--ignore-lock`.
Long enterprise labels have wrapping protection; visual verification is pending.

`verify:output` now checks every HTML file (including standing pages and 404),
canonical tags, valid JSON-LD, local links/assets, escaped evidence values,
robots exclusion and pilot-data leakage in HTML plus XML/JS/CSS/JSON/text.

The new `pnpm accept:site-builder` command preserves step logs, source commit,
input digests, static outputs, browser results and per-file artifact hashes.
`--static-only` reports `STATIC_PASS_BROWSER_NOT_TESTED`, never a complete PASS.
The workflow now invokes this complete acceptance path, but that updated workflow
has not run on GitHub.

## Executed verification

`pnpm accept:site-builder --static-only` completed against the clean tested commit.
All 8 builder/capture tests passed. Each edition passed `pnpm check`,
`pnpm build` and `pnpm verify:output` sequentially in one checkout.

| Synthetic edition | Core routes | HTML files checked | Browser acceptance |
| --- | ---: | ---: | --- |
| Cotton textiles, two products | 5 | 11 | NOT_TESTED |
| Industrial, long name and escaped markup | 4 | 10 | NOT_TESTED |
| Empty product catalog | 3 | 8 | NOT_TESTED |

No prior cotton/industrial company markers were found in subsequent editions'
static outputs in the additional cross-build content scan. This is a build
content-isolation check, not live tenant authorization acceptance.

Artifact inventory SHA256 digests:

- Cotton: `c625c6cd5233ad39ab21caffb1e6be7be9efdb477c72d9d060f23e6bbd4cc986`
- Industrial: `6bc4e281add39954b2c33ef7c07d40ed893c676bb14a388a73e6904d216bfbe0`
- Empty catalog: `223fe4b40d9baaf4b6b2447b5d4011a5aa38337fd9c29ca9b59d60c63cca82d4`

Each digest is SHA256 of a compact, path-sorted JSON array containing each
file's `path`, byte count and SHA256; inventories are included beside each build.
Raw static report: `.generated/acceptance/2026-11-13T08-19-47-637Z/report.json`.

## Browser blocker, actually attempted

A full acceptance invocation for the cotton edition ran all static stages and
then failed at Chromium launch, before opening a page:

`FATAL:chrome/browser/process_singleton_posix.cc:297 ... socket() failed: Operation not permitted (1)`.

System Chromium was version `156.0.8078.79`. The suite stopped after this first
launch failure: 1 test failed to launch, 35 tests did not run. These are not
successful visual or interaction checks. Overall full acceptance status is FAIL.
The report and retained launch log are under
`.generated/acceptance/2026-11-13T08-20-51-069Z/`.

Downloading Playwright's managed browser was also attempted; the download
returned a 195-byte HTML response instead of a browser ZIP. The separate shared
browser could not connect to the build container's loopback preview
(`ERR_CONNECTION_REFUSED`). These alternatives did not yield browser acceptance.

The existing GitHub run `43376406689` belongs to the old commit `e60909c`:
its verify job has `runner_id=0` and `steps=[]`. No test or build ran there.
It is not evidence for these changes, nor evidence of a source failure.

## Remaining release gates

1. Run the committed browser suite in an environment that can launch Chromium;
   inspect screenshots at all three sizes and fix any actual layout defects.
2. Use a server-authenticated, current Enterprise Library export plus authorized
   real website snapshots; synthetic fixtures do not satisfy real-company QA.
3. Add `outputKind=site` to existing Magazine Studio jobs/revisions and reuse
   native authentication, approvals and protected multi-route preview serving.
4. Keep publication blocked pending editorial approval, image permissions,
   verified RFQ/Assistant backend, official domain checks and rollback.

## Delivery status

The user explicitly authorized GitHub upload and continued acceptance on
2026-11-13. The command-line transport had no write credential; the connected
GitHub integration was used to create the equivalent code commit and this report
on `feat/company-to-buyer-site-v0-1`, without force-updating other history.
PR #2 remains Draft. No production deployment or publication is claimed.
