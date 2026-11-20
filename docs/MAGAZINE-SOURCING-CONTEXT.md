# Magazine → Sourcing context bridge

This stacked change connects the source-bound magazine issue to the existing buyer conversion system. It does not add a second form, assistant, CRM, RFQ endpoint or model runtime.

## Behavior
- The enterprise IssueSpec now carries canonical local article paths from the same compiled page contracts that populate pages.json.
- Product gallery entries link to their full source article.
- The issue masthead and closing sourcing spread can open the existing Buyer Assistant.
- The clicked article path is passed as a small local event, then matched against server-generated BuyerBrief records. Only a canonical path from the published edition can become active context.
- Existing SourcingAssistant then supplies the source guide, open conditions and brief composer. If the actual assistant backend is unavailable, the existing source guide remains available; no fake model answer is shown.
- The handoff keeps the buyer on a reviewed brief. It does not send an enquiry. Submission and durable receipt remain in the existing EnquiryForm / Worker flow.

## Isolation and safety
- The standalone Chongker concept route has no enterprise sourceArticles, so it does not mount or open the real buyer assistant.
- Only publicationStatus=private-review issues with a real buyer-guide article show the sourcing trigger.
- The source path must match /<safe-desk>/<safe-article>/; arbitrary external URLs, query strings, tenant IDs and supplier IDs are not accepted.
- The existing server-resolved BuyerBrief remains authoritative for product, supplier, evidence and source identities.

## Verification
- Issue adapter requires and emits the exact canonical article route.
- Browser review of a generated enterprise issue opens the existing assistant and verifies that the selected BuyerBrief matches the guide/article path.
- Concept-only edition remains disconnected from enterprise assistant context.

Reproduce with Node 24 and the existing locked toolchain:
```sh
node --test src/magazine/issue-from-enterprise.test.mjs
pnpm test:site-builder
pnpm check
pnpm build
pnpm test:browser
```

These checks are authored in this branch; they have not been executed here. A GitHub Actions runner allocation failure is not a test result. Do not claim production readiness until a clean build and desktop/mobile browser run pass.