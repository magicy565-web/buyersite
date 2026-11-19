# Next phase after PR #8: source-bound magazine outline

This stacked PR introduces the **first production-input contract**, not another website or a free-form HTML generator.

## Actual data path
OpenMausBot Studio frozen company/product source → existing \`createSiteFromStudio\` → \`compileEnterpriseSite\` → \`planMagazineOutline\` → private \`magazine-outline.json\` in the existing edition pack.

The outline is deterministic, evidence-ID bound, and deliberately lacks:
- invented interviews, supplier quotes, certifications, MOQ or delivery claims;
- unapproved product, factory or process images;
- permission to publish or send a supplier enquiry.

If the enterprise has no selected product records, no product gallery is proposed. No 'craft' section is proposed unless a future editor can cite actual craft-process source material. An agent may propose editorial narrative and a visual plan after this stage, but its result must pass the existing citation/media-review policies and an IssueSpec schema before Astro render.

## Next engineering gates
1. Map source-backed outline sections to PR #8 IssueSpec with per-spread evidence and image rights receipts.
2. Bind media through the existing tenant-specific media registry and actual \`media-report.json\`, **never** through a model-supplied image URL.
3. Render issue-scoped Astro routes from \`BUYERSITE_BUILD_ROOT\`; allow the static default magazine to remain unchanged.
4. Reuse existing BuyerBrief, cited source guide, EnquiryForm and D1 receipts for contextual zero-form sourcing; never treat a local draft as a submitted RFQ.
5. Capture Playwright desktop and 360/390px screenshots. The visual reviewer assesses both spread quality and overall editorial rhythm. Block public release until exact-source checks pass.

## Reproduction
\`\`\`sh
node --test site-builder/magazine-outline.test.mjs
pnpm test:site-builder
pnpm check
pnpm build
pnpm verify:output
\`\`\`

The added output is a private JSON planning artifact. It is not a publicly accessible magazine, nor an OpenMausBot production integration. Hosted CI failure before runner allocation is not evidence of a passing or failing test.
