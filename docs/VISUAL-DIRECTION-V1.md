# Editorial Visual Direction v1 — buyersite

Scope: **private Astro enterprise-edition generation**, stacked on `feat/company-to-buyer-site-v0-1`. It does not create a new frontend or bypass OpenMausBot approval / publication gates.

## What changed

1. `site-builder/visual-director.mjs` chooses one of three curated designs based on **recorded product categories**: `atelier` for fabric/fashion/interior, `industrial` for equipment and parts, `editorial` otherwise. This is a deterministic visual planner, **not** a model invocation.
2. Every generated article now gets its own original, deterministic abstract illustration (`hero-<slug>.png`); a product page, supplier profile and buying guide have different compositions. The image is marked explicitly as illustrative rather than supplier photography.
3. `site.json`, `manifest.json`, and `visual-plan.json` bind the approved profile and article-to-asset mapping. The exact visual plan participates in the source fingerprint.
4. Astro reads the direction in `src/config.ts`, binds it on `<html>`, and applies curated typography, palette, photo crops, and page hierarchy from `src/styles/theme.css`. The original Halftone pilot stays unchanged.
5. Build validation verifies all hero file bindings, unique safe slugs and generated PNG signature; `pnpm check:editorial` verifies WCAG AA text/background token combinations across all three profiles. Build and browser acceptance remain mandatory.

## Media rights and editorial boundaries

- No unapproved product images are copied from supplier websites. The abstract artwork cannot be treated as a product, factory, packaging or certification depiction.
- The existing `MEDIA_RIGHTS_REQUIRED`, editorial approval, unavailable RFQ backend and public deployment blockers **still apply**. Generated enterprise sites remain private and `noindex`.
- The visual profiles are **curated static rules**. A future Visual Director Agent may propose a profile and layout but must return schema-validated selections, with human approval for public publication. It must not generate arbitrary executable code or claim unsupported facts.
- For actual high-end photography, a future asset registry needs file hash, source, photographer/license, approved usage scope and a documented publication grant. Photos must not replace the illustrations merely because they are publicly accessible.

## How to verify on a real checkout

```bash
pnpm install --frozen-lockfile
pnpm test:site-builder
pnpm check:editorial
pnpm accept:site-builder --static-only
# Browser/visual review after Chromium is installed:
pnpm accept:site-builder
```

Review screenshots at 1440px, 390px and 360px on synthetic editions; inspect hero contrast and title overflow with long enterprise names. Then review real **authorized** company content and approved images in protected previews.

## Out of scope in this PR

No live OpenMausBot bridge deployment, production public site, RFQ integration, real company collection, new model credentials, live image licensing or evidence of business conversion. Hosted GitHub Actions are currently unavailable due to the account billing lock; a green CI status cannot be claimed without a fresh run.
