# Builder reproduction and Actions diagnosis — 2026-11-14

## Result

The unchanged builder at `3f3a166d0382d5b14de8219c3f349e63250926da`
passes a fresh frozen-lockfile installation with the **exact configured Node
24.22.1 and pnpm 10.34.5**, all 10 unit tests, three Astro check/build/output
passes, and 96 Chromium browser tests. This closes the earlier pnpm-version
reproduction gap. It is synthetic local acceptance, not green GitHub CI, live
enterprise acceptance, or publication approval.

Execution occurred at 2026-11-13 16:31–16:35 UTC (2026-11-14 00:31–00:35
Asia/Shanghai). The checkout was clean throughout execution. The follow-up
commit changes documentation and retained evidence only; no runtime, dependency,
template, workflow, or production configuration fix was indicated by this run.

## Confirmed cause of the three-second Actions failure

Run [43376406689](https://github.com/magicy565-web/buyersite/actions/runs/43376406689),
job `131723811219`, has this failure annotation:

> The job was not started because your account is locked due to a billing issue.

The job has `runner_id: 0`, no runner name and an empty steps array. The current
head's run [43396780716](https://github.com/magicy565-web/buyersite/actions/runs/43396780716),
job `131789519055`, has the same annotation. Public REST check-run annotations
were read directly because the GitHub connector rejects that endpoint. Retained
responses are in [the evidence directory](2026-11-14-reproduction/).

| Candidate | Evidence-based finding |
| --- | --- |
| Account / execution environment | Confirmed billing lock prevents job startup. |
| Runner OS failure | No runner was assigned. The Ubuntu migration notice is not the failure annotation. |
| Workflow permissions | No denied workflow step or token operation occurred. Broadening permissions would not address the stated cause. |
| Dependencies / source | Neither was executed in this failed run. The current head passes the isolated execution below. This does not retroactively test the old source. |

The workflow was inspected both at the failed SHA `e60909ce...` and at the
current head. Both configure Node 24.22.1, pnpm 10.34.5, frozen installation and
read-only contents permission. The latest workflow additionally runs all three
editions and browser acceptance. No speculative workflow change or paid rerun
was made. The account owner must resolve the GitHub billing lock before a hosted
rerun can establish CI success; this task did not change billing settings.

## Actual verification

| Synthetic edition | Core routes | HTML files checked | Browser tests passed |
| --- | ---: | ---: | ---: |
| Cotton textiles / two products | 5 | 11 | 36 |
| Industrial / long name and special characters | 4 | 10 | 33 |
| Empty catalog | 3 | 8 | 27 |
| Total | 12 | 29 | 96 |

All three typechecks report **0 errors, 0 warnings and 2 existing unused-parameter
hints**. Browser results have zero skipped, flaky or unexpected tests. Coverage
includes all generated index routes at 1440px, 390px and 360px, evidence text,
noindex, local assets, disabled Assistant, enquiry download without submission,
history navigation and deep-link refresh. Static checks include 404 HTML and
other generated HTML, canonical tags, structured data, robots blocking and
absence of the original pilot company in the generated editions.

The standard system Chromium could not start its process-singleton socket in
this executor. The repository's existing test-only headless launcher worked
with `@sparticuz/chromium@153.0.0`; no host policy or production dependencies
were changed. This is not an Ubuntu-hosted-runner reproduction. Astro 7.3.3 and
Playwright 1.65.0 are from the unchanged lockfile.

The desktop textile homepage and 360px long-name industrial homepage screenshots
were visually inspected: content remained inside the viewport and the editorial
artwork was explicitly distinguished from product photography. Extremely long
unbroken names wrap aggressively; this is a remaining editorial consideration,
not a claim of polished real-company visual acceptance. Screenshots and static
builds remain local under the acceptance run; only synthetic test logs, reports
and hash inventories are committed.

## Reproduce without GitHub Actions

Use an isolated checkout of the tested commit with Node 24.22.1. Put the exact
pnpm binary ahead of any preinstalled shim and confirm both version outputs:

```sh
git checkout --detach 3f3a166d0382d5b14de8219c3f349e63250926da
npm install --prefix /absolute/qa-runtime --ignore-scripts --no-audit --no-fund pnpm@10.34.5
export PATH=/absolute/qa-runtime/node_modules/.bin:$PATH
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
SITE_URL=https://buyer-magazine.invalid pnpm accept:site-builder
```

The last browser-install command is the normal CI route. The actual constrained
executor instead used the already documented optional headless runtime:

```sh
npm install --prefix /absolute/qa-runtime --ignore-scripts --no-audit --no-fund @sparticuz/chromium@153.0.0
node scripts/prepare-headless-runtime.mjs /absolute/qa-runtime
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH="$PWD/.generated/qa-runtime/chromium-headless.sh" \
  SITE_URL=https://buyer-magazine.invalid pnpm accept:site-builder
```

The commands need package-registry and build-time font downloads; this is not
an offline build. No real supplier capture is part of this acceptance command.
Reports are written to `.generated/acceptance/<timestamp>/`. A browser-free run
with `--static-only` must remain `STATIC_PASS_BROWSER_NOT_TESTED`.

## Evidence retained

- [Full acceptance report](2026-11-14-reproduction/report.json): fixed source SHA,
  clean checkout, tool versions, input hashes, step results and artifact hashes.
- [Environment and lockfile hashes](2026-11-14-reproduction/environment.json).
- [Frozen dependency installation](2026-11-14-reproduction/install.log).
- [Top-level execution log](2026-11-14-reproduction/acceptance.log).
- [Evidence checksums](2026-11-14-reproduction/evidence-sha256.json).
- Per-edition check/build/output/browser logs, full Playwright JSON results,
  and static file SHA-256 inventories in the same evidence directory.

Paths in raw reports refer to the original executor. Corresponding logs and
inventories are retained here; static dist directories are not published.

## Real input and private preview gates

| Capability | Current acceptance boundary / missing condition |
| --- | --- |
| Enterprise compilation | Accepted against explicit synthetic snapshots, including empty catalogs; no real native export was supplied or read in this task. |
| Native Studio adapter | Unit-tested enterprise/hash/revision/selected-product/permission/URL binding. Must be invoked with a server-owned authenticated job and original source.json bytes; this function is not authentication. |
| Live website capture | Unit-tested using injected transport. Still needs an authorized company HTTPS URL, actual capture through production DNS/TLS/robots checks and a retained URL/time/hash receipt. No live capture is claimed. |
| Private browser preview | Local production-preview routes passed. A server-side authenticated multi-route preview with tenant isolation, session expiry and protected asset access is still unconnected. **noindex and robots are not access control.** |
| Job / revision lifecycle | Existing Studio host must persist the site result and source binding on its job, resume/retry safely and enforce current revision/approval checks. Not integrated by this task. |
| RFQ and Assistant | Verified unsent download and visibly disabled Assistant only; no backend, message delivery or grounded model response accepted. |
| Public release | Still blocked pending real editorial review, approved image rights, backend, final domain checks, approved content version and rollback. |

Next useful acceptance input is a real authenticated Enterprise Library export
plus its server-owned Studio job/source hash and recorded website permission,
handled in a private test environment. Do not commit these to this public
repository. Host wiring requires a separately authorized development/staging
environment; no OpenMausBot production changes were performed.
