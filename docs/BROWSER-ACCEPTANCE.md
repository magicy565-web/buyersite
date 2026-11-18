# Browser acceptance handoff

## Current outcome

The enterprise builder passed **96 Chromium tests across three synthetic editions**
at 1440px, 390px and 360px using Node 24.22.1 and the exact pnpm 10.34.5.
See [the current reproduction and raw evidence](verification/2026-11-14-reproduction.md).
This supersedes the old browser-launch blocker for builder acceptance, not for
real-enterprise ingestion or production rollout. The original real-source pilot
was not re-tested in this run.

System Chromium's process-singleton socket was unavailable in the executor; the
existing optional headless-shell launcher succeeded without changing host policy.
Setup is documented in [the builder guide](../site-builder/README.md#optional-linux-headless-qa-runtime).
GitHub CI is separately blocked by the account billing lock, not browser tests.

## Run in a browser-enabled development environment

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium
SITE_URL=https://buyer-magazine.invalid pnpm accept:site-builder
pnpm exec playwright show-report
```

The acceptance runner builds each edition and starts the production preview on
127.0.0.1:4321. All generated index routes are exercised at the three viewport
sizes. Raw results, screenshots and build inventories for each edition are kept
under `.generated/acceptance/<timestamp>/`; the top-level Playwright HTML report
shows the last edition. No real model response or RFQ submission is simulated.

## Checks and evidence

- All generated index routes at 1440 px, 390 px and 360 px: successful response, one H1, no horizontal overflow, lazy images load, visible header enquiry link, assistant opens, disconnected message and disabled input are visible, Escape closes the dialog and focus returns to the triggering button.
- One unsent enquiry download per viewport: required fields, expected filename and explicit unsent status.
- Each reading case saves a full-page PNG into test-results. Downloads are saved alongside the case output. Failures retain a trace. HTML report is in playwright-report. These directories are ignored by Git.
- Visually inspect all screenshots for heading wraps, crop quality, sticky navigation height, readable source notes and the product specification summary. Automated success alone is not visual acceptance.

## Changes ready for review

The home H1 now names the publication and its lead story is H2. The original photo plate is retained with a shorter minimum height. Enquiry and assistant actions are in the header; product specifications and evidence anchor are before the main image/body. Both assistant triggers restore focus individually. Components receive resolved evidence through props.

Record the tested commit, browser version, viewport, observed failures and screenshot paths before marking this round accepted. AI grounding, tenant isolation, durable RFQ and production crawlability remain separate pending work.
