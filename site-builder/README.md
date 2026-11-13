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
   enterprise revision. Source claims remain _supplier-stated_; nothing is
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
builds two same-slug Worker jobs, verifies private preview and restart isolation,
then compiles, typechecks, builds, checks every built HTML file and runs
Playwright for three **synthetic** editions: a two-product catalog, industrial
data with special characters/long names, and an empty product library.
Sequential builds also detect old collection entries leaking into the next
company's output.

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

### Existing Magazine Studio input adapter

`createSiteFromStudio(job, sourceBytes, options)` in `from-enterprise.mjs`
accepts an existing **server-owned** StudioStore production job and the original
`source.json` bytes from `snapshotSources`. It checks the enterprise binding,
frozen source SHA256, company/product revisions, selected product IDs and the
existing website-capture permission before collection. It maps the native
`enterprise.company` and `products` fields into the existing compiler contract.
Only names, category and description are passed. The website comes from the
server-owned Studio job and must exactly match `snapshot.website`, because the
current native Company record has no website field. Internal SKU prices, supply
policies, private documents, unselected products and unapproved images are
excluded. Returned `source_binding` must be retained on the same Studio job.

This function is a server-side adapter, not an authentication mechanism or a
public upload endpoint. The native job lifecycle, `outputKind=site` selection,
native Studio persistence and version approval are still to be wired in
OpenMausBot; the adapter alone does not claim that live flow is integrated.

### Local build Worker for the existing host bridge

`worker.mjs` is a headless build runtime, not another dashboard or public API.
It matches the existing authenticated Magazine Studio bridge: OpenMausBot keeps
browser authentication and injects `x-magazine-bridge` plus its server-resolved
`x-enterprise-id`; the Worker listens only on `127.0.0.1` and rejects a body whose
job tenant differs from that header.

The bridge calls these relative paths below `/api/magazines`:

- `POST /site-jobs` with a server-owned Studio job (`outputKind: site`) and the
  original `source.json` bytes as canonical base64;
- `GET /site-jobs/:jobId` for durable state and the immutable site revision;
- `GET /site-jobs/:jobId/preview/<route>` for a private multi-route preview;
- `GET /site-jobs` for that authenticated enterprise's jobs only.

Creation returns immediately with `QUEUED`; builds are serialized because Astro
uses one repository `dist/`. Job state and exact source bytes are private files
under a mode-0700 data directory. A restart resumes `QUEUED`/`BUILDING` jobs and
does not rebuild `READY` jobs. The final revision is derived from a SHA-256
inventory of every static byte. Before each job, the Worker removes Astro's
generated single-file content index; a duplicate-slug warning fails the job so
an earlier enterprise edition cannot silently remain in the next build. Preview
reads only inventory-listed files, rechecks exact bytes on every read, rejects
traversal and symlinks, sends no-store/noindex/CSP headers, and returns 404
for another enterprise instead of disclosing that the job exists.

Example private configuration (the token is written by the operator into the
existing mode-0600 `magazine-studio.json`; never commit it):

```json
{ "url": "http://127.0.0.1:4319/", "token": "<40-to-100-character-random-token>" }
```

Start the Worker using the same token and a private, persistent directory:

```sh
BUYERSITE_BRIDGE_TOKEN='<same-random-token>' \
BUYERSITE_DATA_DIR='/absolute/private/buyer-site-worker' \
pnpm site:worker
```

The Worker never publishes a site. `READY` means a private artifact passed
Astro check, build and output verification. Public release remains a separate
approved operation. The host must still persist the returned `sourceBinding`
and revision on the same native Studio job, and its existing authenticated route
must remain the only browser entry. Production service installation is not part
of this repository change. Use a dedicated checkout for the Worker; do not run
an interactive Astro development server from that same checkout concurrently.

### Optional Linux headless QA runtime

If the system Chrome cannot start, a separate test-only runtime can use the
published `@sparticuz/chromium@153.0.0` headless-shell package. It is not added to
the site's production dependencies. In an operator-selected QA directory:

    npm install --prefix /absolute/qa-runtime --ignore-scripts --no-audit --no-fund @sparticuz/chromium@153.0.0
    node scripts/prepare-headless-runtime.mjs /absolute/qa-runtime
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$PWD/.generated/qa-runtime/chromium-headless.sh" pnpm accept:site-builder

The helper prepares an isolated browser launcher using the package's arguments,
with single-process mode removed so that multiple Playwright contexts can be
closed safely. It does not alter host network policy or browser sessions.
Generated reports, browser traces and build outputs are excluded from Astro's
typecheck so a completed run can be followed by another clean check/build.
