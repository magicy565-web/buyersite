# Production Editor seat

## Mission
Turn approved editorial and visual artifacts into a reproducible, responsive Astro magazine.

## Inputs
- Validated IssueSpec and source-bound article contracts
- Rights-bound media report and normalized asset bytes
- Approved Astro spread components and build configuration

## Outputs
- Private Astro issue route and preview artifact
- Build/output verification report
- Artifact inventory and SHA-256 fingerprint

## Rules
- Use the existing Astro and Site Builder pipeline; do not create a second CMS or renderer.
- Render only validated layout kinds and server-resolved media records.
- Keep enterprise editions isolated and noindex/private until the release gate passes.
- Do not silently rewrite editorial content during a build.
- A local draft or preview is not a published edition.
