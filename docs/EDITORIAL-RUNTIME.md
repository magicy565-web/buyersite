# Editorial Runtime Integration

This integration connects the Buyersite virtual editorial department to an existing OpenMausBot workspace and the existing private Site Builder worker. It does not create another workbench.

## Current components

- \`EditorialMissionRuntime\`: durable mission and task state under the worker data directory; source snapshots and artifacts are written with private file permissions.
- \`createEditorialDispatcher\`: binds each role to one existing Bot in the BuyerSite Editorial Department section and dispatches only ready \`openmaus-seat\` tasks.
- \`createOpenMausBotClient\`: uses the configured OpenMausBot HTTPS API and owner/admin session token to import the package, inspect Bots, create task threads and send goals.
- \`createEditorialMcpHandler\`: serves seat-scoped MCP endpoints from the same worker process/runtime. Each Bot receives a task-specific access token; task claims also receive a separate lease token.
- \`artifact-contract.mjs\`: validates typed task output and source/evidence references before durable completion.
- \`site-builder/worker.mjs\`: retains the existing private Astro build, preview and review pipeline.

## Install and bind the seven Bots

The install script is dry-run by default:

\`\`\`sh
OPENMAUSBOT_URL=https://your-openmaus-host.example \
OPENMAUSBOT_SESSION_TOKEN=<owner-or-admin-session-token> \
BUYERSITE_EDITORIAL_BINDINGS=/secure/path/editorial-seat-bindings.json \
node editorial-department/install-openmaus.mjs
\`\`\`

Review the seven Bot names, department section and Chief of Staff. Then explicitly import:

\`\`\`sh
OPENMAUSBOT_URL=https://your-openmaus-host.example \
OPENMAUSBOT_SESSION_TOKEN=<owner-or-admin-session-token> \
BUYERSITE_EDITORIAL_BINDINGS=/secure/path/editorial-seat-bindings.json \
node editorial-department/install-openmaus.mjs --apply
\`\`\`

The binding file stores Bot IDs and role metadata, not the session token. Keep it in a private directory with restricted access. Do not commit it.

If a partial department already exists, the installer refuses to create duplicates; reconcile the existing team manually. Skills are imported as part of the OpenMausBot package. Models, MCP permissions, connected apps, browser/computer access and other runtime permissions remain the workspace owner's responsibility.

## Worker configuration

The existing worker must be bound to loopback and have its private data directory and bridge token configured. The editorial integration adds these optional environment variables:

- \`BUYERSITE_EDITORIAL_SECRET\`: separate secret for the seat-scoped MCP and editorial mission routes; minimum 40 characters and must differ from \`BUYERSITE_BRIDGE_TOKEN\`.
- \`OPENMAUSBOT_BASE_URL\`: the OpenMausBot HTTPS origin (HTTP is accepted only for loopback development).
- \`OPENMAUSBOT_CLIENT_TOKEN\`: owner/admin API session token used by the dispatcher to inspect and message the seven Bots.

Do not expose these secrets to model prompts, Skill files, source snapshots, logs or Git. Use an operating-system secret store or service manager environment injection. The worker's existing bridge token and enterprise ID remain required for Site Worker requests.

## Mission API

All endpoints are served by the existing loopback worker. Requests must include the existing bridge headers:

- \`x-magazine-bridge: <BUYERSITE_BRIDGE_TOKEN>\`
- \`x-enterprise-id: <enterprise-id>\`

Create a mission from a frozen Studio job and exact source bytes:

\`\`\`http
POST /editorial-missions
Content-Type: application/json
\`\`\`

Body fields: \`job\`, \`sourceBytesBase64\`, optional \`issueId\`. The worker verifies the source hash, enterprise ID, website URL, explicit research permission and selected product IDs before creating a mission and dispatching eligible seat tasks.

Read mission state:

\`\`\`http
GET /editorial-missions/mission-<24-hex>
\`\`\`

Read a completed task artifact:

\`\`\`http
GET /editorial-missions/mission-<24-hex>/artifacts/<task-id>
\`\`\`

Human approval routes are authenticated separately and bind the approval to the exact reviewed artifact hash. Approval of the private preview never authorizes public deployment. Public release remains blocked.

## MCP endpoints

The worker serves one endpoint per seat:

\`POST /mcp/<seat-id>\`

Each request must carry an `Authorization: Bearer <seat-token>` header. The seat token is derived server-side from `BUYERSITE_EDITORIAL_SECRET` and the seat ID; the raw mission secret is never sent to a Bot. The MCP tool schema requires a short-lived per-task access token for mission context, claim, completion, failure and dependency-artifact reads. A successful claim returns a distinct lease token; both credentials are required for task completion.

Do not point every Bot at one shared unrestricted MCP server. Configure each Bot with only its own seat endpoint and its derived seat token through the host's protected MCP configuration. Never put the raw mission secret in a prompt or Skill.

## Presence and recovery

The Team Map should consume the durable mission/task state and OpenMausBot's real Bot task/activity state. Do not synthesize "working" status from a planned DAG node. On restart, the runtime reloads persisted mission/task state and the dispatcher may resume eligible queued work. Expired task leases may be reclaimed under the bounded retry policy.

## Team Map projection

The existing OpenMausBot Team Map remains the visual host. The dispatcher creates a real task thread for the bound Bot and sends a goal through the host API; the host's own Bot busy/activity state remains the source of the live working animation. BuyerSite does not synthesize Bot presence.

For durable desk/file state, the worker exposes an authenticated, tenant-bound projection:

```http
GET /editorial-missions/mission-<24-hex>/team-map
x-magazine-bridge: <BUYERSITE_BRIDGE_TOKEN>
x-enterprise-id: <enterprise-id>
```

The response uses `buyersite-team-map/v1` and contains exactly the seven department seats, each seat's real Bot/thread binding when dispatched, task counts, current durable task state, and a file-pile projection made only from completed artifact hashes. It does not expose source snapshots, artifact contents, task access tokens, lease tokens or filesystem paths. A seat is `working` only while a durable task is `running`; queued/blocked/failed work is represented as waiting, and an empty/completed seat is idle. A zero file count means no validated artifact has been completed—never a decorative placeholder.

The endpoint is a read-only projection, not a replacement Team Map API. The host UI should poll it alongside `GET /api/team-map` and its normal Bot list, join by the verified Bot ID, and render file piles from `filePileCount`/ `files`. Native Bot busy/activity continues to drive the character animation; BuyerSite task state supplies the job label and validated file count. If the projection is unavailable, the Team Map must fall back to native Bot state and must not invent a mission or files.

## Verification and release gates

Run in a Node 24 checkout:

\`\`\`sh
pnpm test:department
pnpm test:site-builder
pnpm check:department
pnpm accept:site-worker
\`\`\`

Then perform an explicit dry-run install, import into a non-production OpenMausBot workspace, verify all seven returned Bot IDs and Chief of Staff assignment, configure one seat's MCP endpoint, and run a synthetic-only mission before any real enterprise data is used.

The runtime code is not a claim that the host has been configured or that a live mission has completed. External supplier contact, buyer enquiry submission, quotes/orders, public publication and channel posting remain unavailable or human-gated.
