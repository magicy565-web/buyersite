# Magazine Source Adapter — PR #8.5

This change sits between the PR #8 Astro issue renderer and PR #9's source-bound enterprise outline. It does not add another CMS, runtime, agent service or public endpoint.

## Contract

\`compileMagazineIssueFromEnterprise({ compiled, outline, mediaPlan, mediaReport })\` converts the existing Site Builder output into a versioned \`private-review\` IssueSpec.

It binds:
- the exact compiled source fingerprint;
- the PR #9 outline fingerprint;
- the media plan fingerprint and report fingerprint;
- article IDs, product records and evidence IDs;
- media descriptors for licensed photos, AI-generated concepts and abstract fallbacks.

The issue composer deliberately does not invent craft/process chapters. It adds a product gallery only when selected product articles exist. A no-product enterprise still gets a valid cover, contents, source story, source notebook, buyer questions and sourcing close.

## Media policy

- \`licensed-photo\`: source, grant and rights hashes must match the existing media plan.
- \`ai-generated\`: prompt hash, provider/model and visible concept disclosure are required.
- \`abstract-fallback\`: must disclose that it is conceptual and not a depiction of supplier products or facilities.
- All source media remains \`reviewStatus: required\`. The issue is private; this adapter is not a media or publication approval.

\`assertIssueMediaFiles({ issue, articlesDir })\` verifies that each exact normalized image file exists as a regular non-symlink file and matches the SHA-256 recorded in the issue descriptor. The existing media review path remains responsible for current licence-registry checks, image assessment, page review and release gates.

## Astro rendering

The issue route can now read \`magazine-issue.json\` from the existing \`BUYERSITE_BUILD_ROOT\`. The media component resolves \`articleId\` against the existing Astro articles collection and uses its local image metadata. It does not trust a model-supplied image URL.

The issue is rendered as a noindex private preview. The sourcing end page still creates an unsent local draft; it does not submit an RFQ or contact a supplier.

## Required integration in the stacked PR #9 build

After \`materializeEditionMedia\` writes \`media-report.json\`, the build must:

1. call \`compileMagazineIssueFromEnterprise({ compiled: result, outline: magazineOutline, mediaPlan: result.mediaPlan, mediaReport })\`;
2. call \`await assertIssueMediaFiles({ issue, articlesDir })\`;
3. write \`magazine-issue.json\` into the same private edition root;
4. run Astro with \`BUYERSITE_BUILD_ROOT\` pointing at that root;
5. inspect the generated \`/issues/<issue-id>/\` route at desktop and mobile widths.

That build integration is intentionally left to the stacked PR #9 follow-up so this PR remains independently reviewable on top of PR #8. No source pack, live enterprise ingestion, paid model call, browser acceptance or public deployment is claimed here.

## Tests

\`\`\`sh
node --test src/magazine/issue-contract.test.mjs
node --test src/magazine/issue-from-enterprise.test.mjs
node --test src/magazine/compose-issue.test.mjs
pnpm check
pnpm build
pnpm verify:output
\`\`\`
