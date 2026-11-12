# Material Notes — independent buyer magazine

A real-source Burel Factory pilot using the pinned Halftone theme. Independent from DSH. **Private review only; not deployed or authorized supplier marketing.**

```sh
pnpm install --frozen-lockfile
pnpm prepare:media
pnpm check
pnpm build
pnpm verify:output
pnpm preview --host 0.0.0.0
```

The media step downloads supplier photography for local research review; bytes are not committed. It needs HTTPS access to cdn.shopify.com. Dependencies and self-hosted fonts also need build-time network access.

Core routes: `/`, `/materials/silver-wool-fabric/`, `/suppliers/burel-factory/`, `/guides/burel-project-brief/`. `/enquiry/` downloads an unsent brief. `/colophon/` explains sources and rights.

Assistant connection is optional through PUBLIC_ASSISTANT_API_BASE; the UI clearly reports when it is unavailable. No model calls or fake replies ship by default.

See [architecture](docs/ARCHITECTURE.md), [validation](docs/VALIDATION.md), [theme provenance](template.lock.json), [license](LICENSE) and [third-party notices](THIRD-PARTY-NOTICES.md).
