# Company → Buyer Magazine Site (P0, private preview)

This is the **only prioritized build path**. It is deliberately not a replacement
OpenMausBot dashboard, standalone CRM or a second magazine authoring system.

## What the code now does

1. Accept an authenticated enterprise snapshot from the existing OpenMausBot
   Enterprise Library: tenant id from the server principal, company profile,
   optimistic revision, and current product records.
2. Read the company's declared public **HTTPS homepage** (one page, no recursive crawl).
   Respect robots.txt, verify DNS again before the actual request, pin the
   accepted IP for TLS, reject private/reserved addresses, non-company redirects,
   non-HTML responses, oversized pages and timeouts. JavaScript-only sites may
   fail with EMPTY_SOURCE; never fabricate website facts.
3. Preserve the actual text snapshot, exact SHA-256, URL, capture timestamp and
   enterprise revision. Source claims remain *supplier-stated*; nothing is
   silently marked independently verified.
4. Produce a versioned private site pack: site/route contracts, original source
   snapshots, evidence ledger, magazine article Markdown, one supplier profile,
   up to 12 product stories, a buyer guide and an unsent enquiry form.
5. Build the pack using the **existing pinned Halftone/Astro template**.
   Template-specific static Burel Factory copy, navigation, product context and
   enquiry source are replaced in edition mode, not copied into other companies.
6. Retain original non-product editorial artwork when no supplier-approved image
   is available. The generated preview explicitly does not represent the actual
   product visually.

The default Burel Factory pilot stays available with no environment variable set.

## Internal operator flow

Export a JSON object from the authenticated native Enterprise Library, with this
shape (values must come from real records, not a pasted tenant id from a visitor):

    {
      "enterprise": {
        "id": "<authenticated enterprise id>",
        "revision": 1,
        "company": {
          "displayName": "<display name>",
          "description": "<company's statement>",
          "website": "https://<company-owned-public-site>"
        },
        "products": [
          {"id": "<native product id>", "name": "<product>", "category": "<category>",
           "description": "<native product description>"}
        ]
      }
    }

Site slug is derived deterministically when not supplied. This format is the
private, **server-side adapter contract**. The repository does not contain
an authenticated extraction API for the live OpenMausBot deployment yet.
Do **not** expose native identity, private products or raw capture snapshots as a
public upload endpoint.

Run from the buyersite repository with Node 24 and locked dependencies:

    pnpm install --frozen-lockfile
    pnpm test:site-builder
    pnpm site:from-enterprise /secure/path/native-enterprise-export.json

The command prints the isolated output directory. Then run:

    BUYERSITE_BUILD_ROOT=/absolute/generated/folder pnpm check
    BUYERSITE_BUILD_ROOT=/absolute/generated/folder pnpm build
    BUYERSITE_BUILD_ROOT=/absolute/generated/folder pnpm verify:output
    BUYERSITE_BUILD_ROOT=/absolute/generated/folder pnpm preview --host 127.0.0.1

On Windows PowerShell, set $env:BUYERSITE_BUILD_ROOT to the generated folder
before invoking pnpm; unset it to use the original review pilot.

If an already captured website snapshot is available from a trusted collector,
the lower-level command supports a JSON object with schema_version 1.0.0,
site_slug, exported_at, enterprise, and website_pages. Each page must contain
url, title, captured_at, original body_text and content_sha256.

## Review and release boundary

- Every generated route remains noindex/nofollow, and robots.txt blocks crawling.
- The website capture is public source **review**, not permission to reuse
  supplier photography, logos, certification marks or private documentation.
- Enterprise data marked internal-only may be viewed only in protected previews.
  A static dist/ directory must NOT be published, copied to a public bucket,
  or shared by a public URL until an explicit release review removes or approves
  those facts.
- Generated previews disable the public AI Assistant even if another demo's
  gateway is configured. The enquiry button only downloads a local unsent draft.
- There is no official production domain, publish button, persistent RFQ,
  per-tenant public API gateway or successful live OpenMausBot integration yet.

A release adapter must separately verify: current tenant/profile revision,
each evidence fact and rights grant, approved photography, user approval of a
content-version hash, successful build and output checks, real canonical domain,
a working enquiry or assistant backend, and rollback. The old PR's prior
desktop build and browser evidence are **not evidence for this new branch**.

## Required acceptance for the next P0 increment

1. Authenticated OpenMausBot page: **Create Buyer Site** reads real company and
   products, displays the homepage URL, and starts a durable preview job.
2. The job returns a stable site revision and a restricted preview link. Refresh
   retains the job state. Errors show why collection/compilation failed.
3. The editor shows page cards, citations, missing terms and image rights;
   editing an approved version revokes old approval.
4. Release is blocked until approval + real RFQ path + licensed media +
   deployment QA. Audit the final build hash and support rollback.
5. On a test company's actual records, prove enterprise isolation; a tenant
   never reads another tenant's source snapshot, preview or published site.

Do not parallelize unrelated agents, WhatsApp, Pricing, Chatwoot, ChatKit
redesign, or game work into this milestone.

## Reproducible builder acceptance (Node 24)

After locked installation and `pnpm exec playwright install --with-deps chromium`,
run `pnpm accept:site-builder`. It runs the builder tests, then sequentially
compiles, typechecks, builds, checks every built HTML file and runs Playwright
for three **synthetic** editions: a two-product catalog, industrial data with
special characters/long names, and an empty product library. Sequential builds
also detect old collection entries leaking into the next company's output.

The browser suite derives its routes from the selected build and checks all
HTML routes at desktop 1440px, mobile 390px and mobile 360px, image loading,
evidence text, disabled assistant, an unsent enquiry download, back/forward and
refresh. A bundled Chromium is used normally; an existing system browser can be
selected with `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium`.
No browser-side third-party request is needed.

Reports, step logs, a copy of each static build and a per-file SHA256 inventory
are saved in `.generated/acceptance/<timestamp>/`. The artifact digest is SHA256
of the compact JSON array of `{path, bytes, sha256}` rows, sorted by path. It
identifies the exact static bytes, separately from the source-content fingerprint.
The report records the tested Git commit and whether its checkout was dirty.
The runner never deploys or changes a production host.

In an execution environment that cannot launch Chromium,
`pnpm accept:site-builder --static-only` completes the static checks and reports
`STATIC_PASS_BROWSER_NOT_TESTED`. This is explicitly **not** a complete builder
acceptance. Do not promote that report to PASS or production readiness.

A server-exported input file may be passed explicitly instead of the default
fixtures. Keep its source pack and resulting reports/artifact private; collection
permissions and authenticated enterprise extraction still require live host
integration and independent review. Synthetic acceptance never proves those.
