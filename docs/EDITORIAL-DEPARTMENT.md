# Virtual Editorial Department

## What this is
A portable department contract for the Buyersite virtual digital magazine team. It defines seven on-demand specialist seats, their role briefs, capability allowlists, approval requirements and the issue-mission DAG. It is intended to be bound to OpenMausBot's existing worker/harness runtime later; it does not create seven permanently running agents or another workbench.

## Organization
- Editor-in-Chief — owns the issue brief, story order, delegation and human release recommendation.
- Research Editor — captures authorized sources and maintains the evidence ledger.
- Editorial Editor — drafts buyer-focused copy tied to evidence IDs.
- Art & Photo Director — plans responsive art direction and rights-aware media.
- Production Editor — compiles the IssueSpec and builds the private Astro preview.
- Standards & Review Editor — independently reviews evidence, media and actual desktop/mobile output.
- Audience & Growth Editor — reads owner-authorized aggregate feedback and prepares distribution drafts.

Role briefs live in \`skills/editorial-department/seats/\`. All seats reuse the existing \`skills/buyer-magazine-site/SKILL.md\` production rules and the current Site Builder, Astro renderer, media policy, review and Buyer Runtime.

## Existing team-map placement

The manifest includes six office zones for the seven seats: Editorial Room, Research Library, Creative Studio, Production Floor, Standards Desk, and Audience & Growth. This is placement metadata for the existing OpenMausBot team map, not a new Buyersite dashboard. A future UI adapter should render each seat's presence only from durable task events. Idle movement may be decorative only when no task is active; it must never imply work is running.

## Capability model
\`editorial-department/department.json\` is the machine-readable contract. Each capability is marked:
- \`implemented\`: repository implementation exists;
- \`implemented-gated\`: implementation exists but needs a frozen authorization or owner approval;
- \`planned\`: no implementation is connected yet;
- \`human-only\`: the decision must be made by a person;
- \`forbidden\`: AI seats cannot request it.

\`department.mjs\` validates the manifest and provides \`authorizeSeatCapability\`. It never dynamically imports or executes a tool from JSON. The OpenMausBot adapter must map the capability ID to a separately reviewed tool implementation.

## Issue Mission
\`mission.mjs\` produces a deterministic, source-bound DAG with one tenant ID, one durable Studio job ID, one source SHA-256 and one issue ID. It includes conditional product-story work: an empty selected catalogue creates an explicit no-gallery task rather than a fabricated product feature.

The mission is deliberately \`plan-only\` and \`dispatchable=false\`. It is a typed handoff contract, not an executor. The current OpenMausBot worker remains unbound to these seats. A later integration must:
1. bind seat IDs to existing harness/agent IDs and skill packs;
2. dispatch only capability IDs authorized by the manifest;
3. persist task states and artifact references against the Studio job;
4. derive the pixel-office presence from durable task events;
5. resume only failed tasks against the same immutable source binding;
6. keep public release and external channel posting behind human approval.

## Boundaries
- One enterprise per mission; never mix tenant records or media.
- Website capture requires the existing explicit research authorization.
- Approved photos require current tenant-scoped rights receipts.
- AI-generated images require frozen opt-in and visible concept disclosure.
- Audience analysis receives aggregate feedback, not buyer contact details or raw briefs.
- No AI seat can contact a supplier, submit a buyer enquiry, create a quote/order, read runtime secrets, cross tenant boundaries or publish without human approval.
- Presence is derived from durable job state. No fake "working" animation or synthetic completion event.

## Verification
\`\`\`sh
node --test editorial-department/*.test.mjs
node editorial-department/check.mjs
pnpm test:site-builder
\`\`

The tests validate contracts and plan generation only. They do not prove an OpenMausBot runtime binding, a live model call, a real enterprise issue, a public deployment or external distribution.
