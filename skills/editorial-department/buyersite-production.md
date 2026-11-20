---
name: buyersite-production
description: Apply the Buyersite publishing, evidence, media-rights and Astro production standards when preparing a buyer-facing digital magazine.
---
You are working inside the Buyersite digital magazine production system. The department manifest and the host's server-side capability policy are authoritative. Do not assume repository-relative paths from the original source checkout exist in this installed Skill.

## Editorial and evidence standards
- Select one buyer audience and one buying intent per story.
- Preserve source URLs, capture times, source hashes, evidence IDs, factual status and publication permissions.
- Attribute supplier statements. Never upgrade them into independent verification.
- Never invent commercial terms, MOQ, pricing, delivery, certifications, test results, factory relationships, interviews, testimonials, buyer demand, orders or revenue.
- If evidence is missing, mark the gap and ask the Research Editor. Do not fill it with plausible copy.

## Magazine composition
- Treat each issue as an IssueSpec composed of validated spread kinds, not free-form HTML or CSS.
- Preserve a deliberate editorial arc: cover, contents, stories/features, evidence or buyer notes, and a contextual sourcing close.
- Use the existing Astro spread renderer and pinned design system. Do not create a second CMS, page builder or client-side app.
- Desktop and mobile may use different composition plans while sharing the same source-bound issue content.
- Product galleries exist only when the frozen enterprise snapshot contains selected products.

## Media rights and AI imagery
- Use only tenant-scoped approved media with current source and rights receipts.
- AI-generated images require explicit authorization in the frozen job/snapshot and must be labelled as conceptual artwork.
- Never imply AI imagery depicts the actual supplier product, factory, process, certification or test result.
- Preserve prompt/model/provider provenance and the normalized image hash.
- Do not accept arbitrary model-supplied image URLs or silently replace media.

## Production and review
- Build isolated private previews first. Private previews remain noindex and are not public releases.
- Verify the exact media bytes, issue/source fingerprints, generated routes and output inventory.
- Review actual desktop and mobile screenshots, including narrow-screen overflow, crop, hierarchy, legibility, evidence links and sourcing context.
- Fix only the failing spread or artifact and rerun its dependent checks; do not silently rewrite source facts.
- A successful local build or preview is not a publication approval.

## Commercial and privacy boundaries
- Sourcing interactions may prepare an editable buyer brief with the current article context.
- Only the buyer may submit their enquiry with explicit consent through the existing server-side flow.
- Never contact suppliers, submit enquiries on a buyer's behalf, create quotations or orders, read other tenants' data, or access runtime secrets.
- Public publication and external distribution require human approval.
- Do not claim a task is running or complete unless the host's durable mission/job state confirms it.
