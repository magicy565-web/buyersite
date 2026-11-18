# Independent buyer magazine pilot

The application is a pinned Halftone/Astro static site. There are no DSH runtime packages, SDK imports, sessions, Cordis patches or host presentation calls.

- Theme: template.lock.json records the source commit. MIT and upstream notices are retained.
- Content: src/content/articles contains three real-source editorial pages; the home is rendered by the original theme. src/data/evidence.json records supplier claims, capture dates, permissions and source URLs.
- Contracts: legacy/schemas retains the exact three source contracts. validate-content generates and validates route contracts and cross-references before the build. They are an export projection of the pilot content, not yet a generic contract-to-theme renderer.
- Skills: skills/buyer-magazine-site is the active runtime-neutral entry point. legacy/skills retains original instructions only as migration provenance; their old deployment/runtime commands do not apply.
- Media: prepare-media fetches one real supplier product photo for local private review. Bytes and hash receipts are ignored by Git. Replacing it with approved imagery is required before public release. The same product image on other pages is explicitly credited as product photography, not a factory photo.
- Assistant: a native dialog, disabled until PUBLIC_ASSISTANT_API_BASE is configured. Uses POST /v1/public-sites/material-notes/sessions and /chat, X-Visitor-Session, JSON answer envelopes. No streaming backend is implemented. The gateway must resolve tenant and allowed facts on the server, enforce origin/session limits and return stable errors. No provider keys belong in browser variables.
- RFQ: the enquiry route downloads an unsent brief only. No backend, durable RFQ or supplier messaging is implemented. A future adapter must create a draft, show review, submit with explicit buyer confirmation and return a durable case ID.
- Publishing: every page is noindex; robots disallows crawling. The placeholder .invalid base URL intentionally prevents claiming a live deployment. Set SITE_URL for a local review build only. Do not deploy publicly until image permissions, facts, gateway and conversion acceptance have been reviewed.

## Next acceptance

Inspect desktop and 360/390 px layouts, keyboard dialog focus and draft download. Production SEO requires a real deployment with anonymous route fetches, valid canonical URLs, robots/sitemap, structured data matching visible facts and search-console inspection. Static HTML checks alone do not establish search eligibility or GEO results.
