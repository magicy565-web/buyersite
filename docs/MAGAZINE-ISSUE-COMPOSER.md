# Magazine Issue Composer — Chongker concept, private only
This is a new **editorial issue layer** inside the existing Astro 7 / Halftone buyersite. It does **not** replace current product, supplier, guide, evidence, D1, or RFQ routes.

## Use
- Route: /issues/chongker-concept/
- Default: **no route is produced**. Opt in only on a private local checkout: BUYERSITE_MAGAZINE_CONCEPT_PREVIEW=1 pnpm build
- Source: src/data/magazine-issues/chongker-concept.json
- Validator: src/magazine/issue-contract.mjs
- Renderer: src/components/magazine/{Issue,Spread,Media}.astro
- Visual tokens: src/styles/magazine-issue.css
- Standalone schema tests: node --test src/magazine/issue-contract.test.mjs

## Agent contract
1. Evidence editor obtains source records and commercial permissions. Preserve source URL, timestamp, quote and status in the existing evidence system.
2. Editor agent proposes a complete IssueSpec with cover, contents, body, buyer notes and an ending; it cannot generate executable HTML.
3. Visual agent selects from reviewed spread kinds (cover, contents, story, craft, gallery, notes, sourcing) and media IDs only.
4. acceptMagazineProposal rejects media outside the approved registry. There is no way to promote a generated illustration to a real supplier photograph by changing the caption.
5. Astro renders a deterministic story order. Build, media review, mobile/desktop screenshots and release fingerprint gate the artefact.
6. Publishing and live sourcing are **not connected to this private experiment**. Production should reuse the existing owner-authorized enterprise data, approved-image registry, server-resolved enquiry provenance, and publication controls.

## Limits
This branch includes a self-contained concept edition and original VECTOR illustration placeholders, not approved Chongker photography. All supplier capabilities, certification, quantities, commercial terms and performance claims are unknown. No agent/model call or production OpenMausBot bridge has been exercised. A separate high-fidelity offline visual preview was prepared in the conversation with previously generated AI editorial concept crops; it is not a public site.

Current implementation is an **issue compositor prototype**. Additional production work must bind issue-scoped assets to the existing rights registry, reuse source-backed BuyerBrief/evidence, integrate the EditionSpec with the Site Builder and run the complete Astro/Playwright acceptance chain against real approved inputs.