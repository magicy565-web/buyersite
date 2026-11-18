# Buyersite — buyer magazine, sourcing and enquiry

Buyersite turns approved company facts and public sources into a buyer-facing magazine. The site is the acquisition and conversion entry point: readers explore materials, inspect source facts, prepare enquiries and create feedback that the existing OpenMausBot editorial workflow can consume. Shopify fulfilment and supplier messaging are outside this repository.

The current foundation is **Astro 7 + Halftone + Tailwind 4**, with Markdown/MDX content and focused **React 19 / assistant-ui** islands. A small Cloudflare Worker wraps the static magazine with D1 enquiry storage and aggregate feedback. The default edition is the Burel Factory material research pilot; generated company editions remain isolated private previews.

## Three-stage architecture

| Stage | Implemented components | Main code |
| --- | --- | --- |
| 1. Editorial production | Source/evidence contracts, four reusable editorial blocks, three visual directions, authorized-photo selection or labelled AI concept generation, screenshot review and release checks | [site-builder](site-builder/README.md), [media and visual review](docs/MEDIA-AND-VISUAL-REVIEW.md), `src/components/editorial/` |
| 2. Buyer conversion | Sourcing dialog, cited source-fact search, optional existing AI gateway, consented buying briefs, durable receipts and owner review | [runtime contract](runtime/README.md), `src/components/buyer/`, `runtime/gateway.mjs` |
| 3. Publication and feedback | Static Pagefind search, canonical/robots/sitemap controls, Worker deployment, first-party aggregate events and authenticated editorial feedback | `scripts/finalize-site.mjs`, `scripts/release-gate.mjs`, `runtime/analytics.mjs`, `runtime/feedback.mjs` |

The image path distinguishes authorized commercial photos from unavailable imagery. Generated images carry concept-art labels and provenance; they are not evidence of a supplier's actual product, factory, certification or capacity. The pilot uses three reviewed AI concept images recorded in [concept-media.json](src/data/concept-media.json). Its media preparation verifies their hashes and visible disclosures and no longer downloads supplier photography.

## Local build and verification

Use **Node 24** for the complete runtime and SQLite test suite. `package.json` pins **pnpm 11.25.0**. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm test:site-builder
pnpm test:runtime
pnpm check
pnpm check:contrast
pnpm build
pnpm verify:output
pnpm check:release
```

`pnpm build` automatically runs media verification, content validation and editorial-profile checks before Astro. It then creates the Pagefind index and bundles the same-origin Worker. Dependencies and self-hosted fonts require build-time network access.

For the complete local site, after a successful build:

```sh
pnpm dev --port 4321
```

Open `http://localhost:4321`. This serves the built site and uses `.generated/dev-inbox.sqlite` for local enquiries/events. Rebuild after source changes. `pnpm dev:astro` is available for layout development, but does not provide the Worker API. In a managed Sites workspace, use `sites-preview start <absolute-checkout>` and the URL it returns for browser review.

The default release output is `dist/client/` plus `dist/server/index.js`. A plain static upload does not provide the enquiry API. An enterprise build selected with `BUYERSITE_BUILD_ROOT` remains a separate static private-preview artifact; see the [builder contract](site-builder/README.md).

## Deploy the reviewed source

1. Set the intended canonical origin and feature switches in [publication.json](src/data/publication.json). Public indexing is gated by a review report matching the exact source fingerprint, completed visual review, a verified persisted enquiry receipt and approved evidence. Run the checks above against that source.
2. Preserve the existing Site identity and `DB` binding in [.openai/hosting.json](.openai/hosting.json). Commit both SQL migrations and their metadata under `drizzle/`. Keep runtime secrets outside the source and browser bundle.
3. Use the Sites source workflow to push the exact source commit, package its matching build, save the Site version and deploy that saved version. This is a Worker deployment with static assets and D1, not a static `dist/` deployment. Preserve the Site's audience unless an audience change is authorized.
4. Verify the deployed capability endpoint, source search and an explicitly labelled test enquiry. Check its persisted receipt through owner access and archive the test record. Confirm release headers, search and responsive pages on the deployed version. A successful local build alone does not establish a successful deployment.

The repository does not itself prove live hosting, domain verification or connected account state. Consult the deployment result and retained verification evidence for the version being released. [runtime/README.md](runtime/README.md) specifies the APIs and server-only configuration.

## Connected capabilities and current limits

- **Source-fact search works without an AI key.** It returns matching published facts with article and original-source citations. It does not infer unknown prices, MOQs or certifications.
- **Live AI sourcing is not yet configured.** `BUYERSITE_SOURCING_URL` and `BUYERSITE_SOURCING_TOKEN` can connect an upstream implementing the sessions/chat contract in `runtime/README.md`. The documented OpenMausBot MCP endpoint has not been verified as compatible with that REST contract. Until a compatible service is connected, the interface labels its source-guide mode explicitly.
- **Enquiries are stored in the Buyersite sourcing inbox.** A receipt confirms storage. It does not mean a supplier has been contacted or a quote/order exists.
- **Feedback is an owner-authenticated API, not a dashboard.** It exposes aggregate actions and persisted enquiry counts for the existing editorial worker. It does not count unique visitors or automatically revise/publish content.
- **Google Search Console and Umami are not connected.** The repository has first-party aggregate events; indexing/account verification and external analytics setup require their own working connections. A sitemap or verification-token field is not evidence that Google has indexed the site.
- **Generated enterprise editions retain private-preview boundaries.** Existing reports and synthetic fixtures do not prove live OpenMausBot extraction, real licensed-photo acceptance or public tenant releases.

## References and retained history

- [Current three-stage integration acceptance](docs/verification/2026-11-18-launch.md) and [source-bound release review](docs/verification/launch-review.json).
- [Media and screenshot review](docs/MEDIA-AND-VISUAL-REVIEW.md), [editorial directions](docs/VISUAL-DIRECTION-V1.md), [browser acceptance procedure](docs/BROWSER-ACCEPTANCE.md).
- [Earlier Node 24 reproduction report](docs/verification/2026-11-14-reproduction.md): historical synthetic-build/browser evidence, not acceptance for subsequent commits.
- [Original pilot architecture](docs/ARCHITECTURE.md), [validation notes](docs/VALIDATION.md), [inherited theme deployment guide](docs/deploy.md): retained references; their static-only assumptions predate the Worker conversion layer described here.
- [Pinned theme provenance](template.lock.json), [license](LICENSE), [third-party notices](THIRD-PARTY-NOTICES.md).
