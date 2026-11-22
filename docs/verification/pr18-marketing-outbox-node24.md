# PR #18 — marketing outbox isolation and lease fencing validation

Date: 2026-11-23 (Asia/Tokyo)
PR: https://github.com/magicy565-web/buyersite/pull/18

## Review baseline and changes

Reviewed initial HEAD `0ee7edc7817c9aa938fde97d440066f92f307099` and Codex findings. The persisted retry-state assertion had already been corrected to `pending`; it was not reworked.

- `c0ec623110005e8d87d031a35d8b895af1d52aad`: scope both pending and expired lease claims to `siteSlug`; fence completion with `site_slug`, monotonically incremented `attempts` and the exact `lease_until`; claim individual rows just before dispatch, rather than leasing a sequential batch up front. No new D1 schema or migration.
- `f2e9facacee5e101279200458396c3c2d1955e4b`: correct the concurrent test to compare SQLite row fields individually (Node SQLite returns null-prototype row objects).

## Local Node 24 / real SQLite test evidence

Runtime: **Node v24.11.1** (the Node executable bundled with local Playwright). Each file used in the isolated local test was compared against the GitHub blob SHA:

| File | Git blob SHA |
| --- | --- |
| `runtime/marketing-outbox.mjs` | `3ac264ae70edc41cbb5ece475176fa5825007f24` |
| `runtime/marketing-outbox.test.mjs` | `b8497162cf7b12d1b2a2a3037d24984ff8c92ddd` |
| `drizzle/0003_marketing_outbox.sql` | `05b6ee942d667a1795c61642dae43cd2e51feb4d` |

Commands: `node --check runtime/marketing-outbox.mjs`, `node --check runtime/marketing-outbox.test.mjs`, and `node --test runtime/marketing-outbox.test.mjs`.

**Result: 7 tests passed, 0 failed** (148 ms in the recorded run). Tests used real in-memory SQLite and injected `fetchFn` stubs. Coverage includes HMAC/acknowledgement, pending when disconnected, transient retry/backoff, invalid campaign IDs, edition isolation for pending and expired leases, stale owner completion fencing, and per-item fresh leases.

## CI and limitations

GitHub Actions PR workflow run https://github.com/magicy565-web/buyersite/actions/runs/45057633580 was reported `failure` within four seconds, with no job steps returned. This is not evidence of a failing Node test; the cause of early failure is not verified. The workflow specifies Node `24.22.3`, but that hosted suite did **not** produce a confirmed test result.

The isolated local checkout contains only the three SHA-verified relevant files, not the full repository. Therefore the full `pnpm test:runtime`, build and release suite are **not** claimed to have passed. Production D1, real webhook credentials and external delivery were not used.

The separate Codex P2 finding about atomic enquiry+outbox insertion in `runtime/gateway.mjs` remains outside this scoped fix and needs an independent follow-up.
