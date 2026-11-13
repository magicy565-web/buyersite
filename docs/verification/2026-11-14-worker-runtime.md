# Private Site Worker runtime acceptance — 2026-11-14

## Result

The locally tested implementation commit
`4f14b3eb095fbdeba6d6a41446940f6a6e48958c` and the published equivalent
implementation commit `b9e2d34778529b1b9f9fd8a08586ed37fec10c86` have the identical Git tree
`d78b45f16100159c20728325ce1383bcf7ea62e3`. That tree passes the complete
synthetic acceptance suite from a clean checkout with Node `v24.22.1` and pnpm
`10.34.5`. The run started at 2026-11-13 17:09 UTC
(2026-11-14 01:09 Asia/Shanghai), reports `source_dirty: false`, and finished
with `PASS`.

This establishes a repeatable private build runtime. It does **not** establish
live OpenMausBot integration, a real-enterprise delivery, a successful live
website capture, or public publication.

## Implemented runtime

- A loopback-only headless Worker accepts existing server-owned Studio jobs and
  original frozen `source.json` bytes through the authenticated Magazine Studio
  bridge contract.
- Jobs persist as `QUEUED`, `BUILDING`, `READY` or `FAILED`, survive restart,
  retry a failed build without replacing its frozen source, and serialize Astro
  builds that share one repository `dist/`.
- Every job runs `astro check`, the production build and output verification.
  Its immutable revision is derived from a SHA-256 inventory of the exact static
  bytes.
- Private multi-route previews are tenant-bound, inventory-bound and rehash the
  requested file on every read. They use no-store, noindex and CSP headers and
  return 404 for a different enterprise.
- The adapter now matches the actual native Company record, which has no website
  field: the server-owned job URL must exactly match `snapshot.website`. Only
  selected product IDs enter the compiler or returned source binding; unselected
  products, internal SKUs, prices, documents and unapproved media remain out.
- Astro's generated single-file content index is cleared before each serialized
  job. Any duplicate-slug warning fails closed as `BUILD_CONTENT_COLLISION`.
  This prevents a previous enterprise edition from remaining in the next build.
- There is no publish endpoint. `READY` means private preview only.

The first real Worker attempt exposed and retained a deterministic copy-stage
defect: the code created the staging directory and then invoked `cp` with
`errorOnExist`. All Astro stages had passed but the job became `FAILED` with
`ERR_FS_CP_EEXIST`. The minimal repair lets `cp` create the target and then
sets its mode. A second run exposed an Astro same-slug cache warning between
two external edition roots; cache isolation and a fail-closed collision check
were added before acceptance was repeated.

## Clean-commit verification

| Scope | Result |
| --- | --- |
| Builder, capture, Studio adapter and Worker tests | 13 passed, 0 failed |
| Worker runtime | Two same-slug jobs `READY`; two real Astro builds; private preview 200 |
| Worker restart | `READY` jobs retained and not rebuilt |
| Cross-build content isolation | Second preview contains only its marker; no duplicate-slug warning |
| Cotton / two-product edition | check, build, 11-HTML output and 36 browser tests passed |
| Industrial / escaped long-name edition | check, build, 10-HTML output and 33 browser tests passed |
| Empty product catalog | check, build, 8-HTML output and 27 browser tests passed |

Worker artifact SHA-256 values:

- first same-slug build: `204eff471f8027ea5f4abc3664f0572abaa516749979cbc52a6c663aeff4c7f4`
- second same-slug build: `c2b88932e8830e7605be8be76a749d5bac1105a3c0f8e3a3276e767e0311441d`

Browser-accepted edition inventory SHA-256 values:

- cotton: `821daeab13831bc4e2e06cdfe33432de24106930cc68a09c812e88b750680a45`
- industrial: `4ffe2a8396740f5fe9b09a6f994fad9d2a12000ecd8c505135aff37e48deb9a4`
- empty catalog: `96db29e295d5ee8caf5929f10f0caf29ba93a55299a0c32513e1653b469f0deb`

The browser total is 96 successful tests across 1440px desktop, 390px mobile
and 360px mobile. The system browser could not launch in this executor, so the
documented test-only `@sparticuz/chromium@153.0.0` launcher was used. It is not a
production dependency. No artifact was deployed.

## Retained evidence

The adjacent `2026-11-14-worker-runtime/` directory contains the generated
acceptance report, Worker summary, unit-test log, Worker top-level log, both
Worker jobs' Astro check/build/output logs, browser logs and static byte
inventories. The generated static sites and frozen source snapshots are not
committed, even though all inputs here are synthetic. Terminal ANSI color codes
were removed from committed log copies; messages and results are otherwise
unchanged.

## Remaining live acceptance gates

| Capability | Current boundary / required next condition |
| --- | --- |
| Native job creation | The existing host bridge can proxy relative routes and inject its authenticated enterprise id, but the host still needs a staging change that creates `outputKind=site` jobs. |
| Native product read | The current host snapshot reader must include the selected versioned products, not only company/documents. |
| Result persistence | The host must persist returned site revision, artifact hash and `sourceBinding` on the same Studio job and expose its protected preview path. |
| Real enterprise input | NOT_TESTED. Supply a private authenticated company record, selected product records and explicit collection permission; do not commit them here. |
| Live HTTPS capture | NOT_TESTED. Run the real DNS/TLS/robots collector against the authorized company URL and retain URL/time/SHA-256. |
| Editorial/browser review | Required on the real company's content and approved media. Synthetic fixtures are not a customer delivery. |
| Public release | Blocked pending approval, image rights, real enquiry/Assistant backend, canonical domain, deployment QA and rollback. |

No OpenMausBot production service or configuration was changed. GitHub-hosted
Actions remains unable to start while the account billing lock is active; that
external state does not invalidate this isolated acceptance, but a green hosted
run cannot be claimed until the lock is resolved.
