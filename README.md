# Material Notes — independent buyer magazine

Company records and website snapshots become a buyer magazine using the pinned
Halftone theme, independently from DSH. **Private review only; not deployed or
authorized supplier marketing.** The original Burel Factory pilot remains the
default edition when no generated company content is selected.

The prioritized enterprise builder is documented in [site-builder/README.md](site-builder/README.md).
It now passes a fresh Node 24.22.1 / pnpm 10.34.5 locked install, 10 unit tests,
three check/build/output runs (29 HTML files), and 96 browser tests using explicit
synthetic fixtures. See the [reproduction report and retained logs](docs/verification/2026-11-14-reproduction.md).
GitHub-hosted checks are blocked by a confirmed account billing lock, before a
runner starts. Local success does not mean CI or live enterprise acceptance.

For synthetic builder acceptance, with those exact tool versions:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
SITE_URL=https://buyer-magazine.invalid pnpm accept:site-builder
```

For the original real-source research pilot (not the synthetic acceptance path):

```sh
pnpm install --frozen-lockfile
pnpm prepare:media
pnpm check
pnpm build
pnpm verify:output
pnpm preview --host 127.0.0.1
```

The media step downloads supplier photography for local research review; bytes are not committed. It needs HTTPS access to cdn.shopify.com. Dependencies and self-hosted fonts also need build-time network access.

Core routes: `/`, `/materials/silver-wool-fabric/`, `/suppliers/burel-factory/`, `/guides/burel-project-brief/`. `/enquiry/` downloads an unsent brief. `/colophon/` explains sources and rights.

Assistant connection is optional through PUBLIC_ASSISTANT_API_BASE; the UI clearly reports when it is unavailable. No model calls or fake replies ship by default.

See [architecture](docs/ARCHITECTURE.md), [validation](docs/VALIDATION.md), [theme provenance](template.lock.json), [license](LICENSE) and [third-party notices](THIRD-PARTY-NOTICES.md).

Browser review procedure and scope: [BROWSER-ACCEPTANCE.md](docs/BROWSER-ACCEPTANCE.md).
Authenticated live input extraction, protected previews, real RFQ/Assistant
services and public release remain separate pending gates. noindex/robots do
not protect private data; do not expose generated builds on public hosting.
