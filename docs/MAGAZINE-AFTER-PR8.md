# Magazine production path after PR #8

This stacked change connects the enterprise source compiler to the Astro magazine issue renderer. It does not add another CMS, website system or public publishing API.

## Current private build path

OpenMausBot Studio frozen company/product source
→ existing \`createSiteFromStudio\`
→ \`compileEnterpriseSite\`
→ \`planMagazineOutline\`
→ existing tenant-scoped media planner and renderer
→ \`compileMagazineIssueFromEnterprise\`
→ \`assertIssueMediaFiles\`
→ private \`magazine-issue.json\`
→ Astro \`/issues/<issue-id>/\`
→ desktop/mobile visual review and Playwright route sweep.

The generated issue binds the exact company-source fingerprint, outline hash, media-plan hash, media-report hash, article IDs and evidence IDs. Image descriptors are bound to exact normalized image bytes. Licensed photos retain source/grant/rights hashes; AI-generated images retain prompt/provider/model provenance and concept disclosure; abstract fallbacks remain visibly conceptual.

The full magazine route is included in the existing screenshot reviewer. Its exact issue hash is included in the review source fingerprint, so changing the issue after review invalidates that review. The Playwright route sweep exercises the issue's local sourcing draft as well as every standard route.

## Editorial rules

- The cover, contents, source story, product gallery (only when selected product records exist), source notebook, buyer questions and sourcing close are assembled from existing records.
- No craft/process story is invented without source material.
- Source facts and source article records are immutable across the agent editing handoff. The agent may propose editorial composition and wording, but cannot rewrite evidence, tenant identity, source fingerprints or media provenance.
- Every private spread declares its evidence-reference list. This does not itself prove every generated sentence is true; an editorial fact review is still a required gate.
- The issue remains private and noindex. The sourcing page prepares a local unsent brief; it does not submit an RFQ or contact a supplier.

## Next gates

1. Run the full Node 24 test suite, Astro check/build/output verification and Playwright on a real checkout.
2. Inspect the complete generated issue at 1440px, 390px and 360px, including source notebook and sourcing end.
3. Run the existing AI image and page review with actual authorized configuration; fixture assessments cannot pass release.
4. Bind the real OpenMausBot Studio job to this worker and persist the issue revision, source binding and review receipts on the same job.
5. Only then review a real enterprise's content and image rights for public publication.

## Reproduction

\`\`\`sh
node --test src/magazine/issue-contract.test.mjs
node --test src/magazine/compose-issue.test.mjs
node --test src/magazine/issue-from-enterprise.test.mjs
node --test site-builder/magazine-outline.test.mjs
pnpm test:site-builder
pnpm check
pnpm build
pnpm verify:output
pnpm test:browser
\`\`\`

A GitHub Actions failure before runner allocation (runner_id=0) is not a test result. Do not claim complete acceptance until the commands above execute in a real checkout.
