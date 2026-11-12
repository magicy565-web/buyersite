# Browser acceptance handoff

## Current outcome

BLOCKED, not passed. Production build and static checks pass. No current desktop/mobile screenshot has been produced. Local Chromium startup is denied at socket creation; the running browser blocks file URLs. Do not bypass browser or executor security policy to complete this check.

## Run in a browser-enabled development environment

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm test:browser
pnpm exec playwright show-report
```

The tests start the production preview on 127.0.0.1:4321. Clear PUBLIC_ASSISTANT_API_BASE before building when testing the default disconnected state. No real model response or RFQ submission is simulated.

## Checks and evidence

- Four core routes at 1440 px, 390 px and 360 px: successful response, one H1, no horizontal overflow, lazy images load, visible header enquiry link, assistant opens, disconnected message and disabled input are visible, Escape closes the dialog and focus returns to the triggering button.
- One unsent enquiry download per viewport: required fields, expected filename and explicit unsent status.
- Each reading case saves a full-page PNG into test-results. Downloads are saved alongside the case output. Failures retain a trace. HTML report is in playwright-report. These directories are ignored by Git.
- Visually inspect all screenshots for heading wraps, crop quality, sticky navigation height, readable source notes and the product specification summary. Automated success alone is not visual acceptance.

## Changes ready for review

The home H1 now names the publication and its lead story is H2. The original photo plate is retained with a shorter minimum height. Enquiry and assistant actions are in the header; product specifications and evidence anchor are before the main image/body. Both assistant triggers restore focus individually. Components receive resolved evidence through props.

Record the tested commit, browser version, viewport, observed failures and screenshot paths before marking this round accepted. AI grounding, tenant isolation, durable RFQ and production crawlability remain separate pending work.
