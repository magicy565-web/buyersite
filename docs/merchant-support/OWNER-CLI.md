# Merchant support owner CLI

`scripts/merchant-support.mjs` is a dependency-free administrative client for the
BuyerSite owner API. Importing the module performs no request. Running a command
performs one explicitly selected request; there are no background writes or
automatic retries. The client does not contact Business Hub, submit a claim,
publish an OpenAI agent, or send a customer message.

## Configure the environment

Set `BUYERSITE_MERCHANT_ADMIN_ORIGIN` to the exact public HTTPS origin of the
BuyerSite deployment. Paths, credentials, query strings, and fragments are not
accepted. Supply `BUYERSITE_ADMIN_TOKEN` through your existing secret-management
process. This is the same owner token the BuyerSite gateway already uses; no
second owner token is introduced.

The token must contain 32 to 512 visible ASCII characters. Do not put it in a
command argument, JSON input file, repository, or terminal transcript. The CLI
does not print it and redacts credential fields or a reflected copy of the
configured token from successful JSON responses. Error responses are reduced to
an HTTP status and a fixed explanation.

The server separately requires `BUYERSITE_MERCHANT_OWNER_ID` for writes. The
server derives the merchant binding and active knowledge revision from its
configuration and repositories. The CLI cannot override them with a request
body.

```sh
node scripts/merchant-support.mjs --help
node scripts/merchant-support.mjs status
```

The commands use Node 22.12 or later. No additional package installation is
needed for this script.

## Commands and routes

| Command | Request | Effect |
| --- | --- | --- |
| `status` | `GET /api/buyer/admin/merchant-support` | Reads the configured merchant's support and onboarding status. |
| `knowledge-save FILE` | `POST /api/buyer/admin/merchant-support/knowledge` | Persists an owner-approved immutable knowledge version. |
| `knowledge-activate FILE` | `POST /api/buyer/admin/merchant-support/knowledge/activate` | Makes a saved version active using an expected revision. |
| `claim-pack` | `GET /api/buyer/admin/merchant-support/claim-pack` | Reads the manual Business Hub setup pack. |
| `claim-evidence FILE` | `POST /api/buyer/admin/merchant-support/claim-evidence` | Records an owner-observed event and evidence reference. |

Use `-` instead of `FILE` to read JSON from stdin. Inputs must be one UTF-8 JSON
object, with at most 512,000 bytes. Input file paths must identify regular files;
directories, symbolic links, and devices are rejected. Inline JSON flags are not
supported. The server applies its own request-size, ownership, schema, and
source-approval checks; passing a CLI check does not establish that a fact is
true or authorized.

### Save and activate knowledge

Prepare an approved knowledge file using the fact schema in
[KNOWLEDGE-AND-CLAIM.md](KNOWLEDGE-AND-CLAIM.md). Include only the intended public
facts and their real citations.

```sh
node scripts/merchant-support.mjs knowledge-save ./approved-knowledge.json
```

The save response includes a SHA-256 `revision`. Saving does not activate the
version. Create an activation JSON file containing only `revision` and
`expectedRevision`, using the actual revision returned by the save and the
currently active revision from the owner status. `expectedRevision` is `null`
only for a merchant's first activation.

```sh
node scripts/merchant-support.mjs knowledge-activate ./activate-knowledge.json
```

If a concurrent change produces HTTP `409`, read the status and review the
competing change. Do not replace the expected revision blindly or automatically
retry a write.

### Prepare the setup pack

```sh
node scripts/merchant-support.mjs claim-pack
node scripts/merchant-support.mjs claim-pack --out ./merchant-claim-pack.json
```

Without `--out`, the result is printed as JSON. With `--out`, the command creates
a new file with owner-only permissions and prints a short success message. It
refuses to overwrite an existing path. Only `claim-pack` supports `--out`.

The pack includes current approved knowledge and an explicitly manual setup
procedure. `official_status_verified` remains false. Complete the external
verification and publishing steps in the real Business Hub interface with an
authorized account, subject to the platform's availability and eligibility.

### Record an observed claim event

Prepare a JSON object containing `expectedRevision` plus the evidence fields
documented in [KNOWLEDGE-AND-CLAIM.md](KNOWLEDGE-AND-CLAIM.md). Use a stable UUID
`event_id`, the current integer claim-state revision, a redacted opaque artifact
reference, the actual artifact checksum, and the real observation timestamp.

```sh
node scripts/merchant-support.mjs claim-evidence ./claim-observation.json
```

The owner is responsible for inspecting and retaining the underlying evidence.
This local record does not verify the artifact bytes or the external OpenAI
state. Do not include identity documents, domain-verification tokens, or personal
data. Preview and publication events must cite the active knowledge revision;
the server compares that evidence with its own current repository state.
`actorId`, `activeKnowledgeRevision`, and `platform_verified` are not accepted
request fields.

## Failure handling and verification

Every request has a 15-second timeout and uses the configured origin without
redirects. The CLI never follows a login or cross-origin redirect with the owner
token. It accepts bounded JSON responses only and does not print raw upstream
errors. Exit code `0` indicates a successful request and usable output; `1`
indicates an input, transport, HTTP, response, or file error.

A timeout after a write does not establish whether the server stored it. Read
the current state before repeating the operation. Knowledge versions are content
addressed, activation uses compare-and-swap, and claim evidence has event-ID
idempotency; preserve those identifiers when reconciling an uncertain response.

Run the isolated tests without contacting a server:

```sh
node --test scripts/merchant-support.test.mjs
```

The suite verifies fixed endpoint routing, explicit write selection, credential
redaction, rejected redirects, stale-revision failures, bounded JSON input and
output, private file creation, and refusal to overwrite existing files. Its
network dependency is a fake fetch function. Live acceptance requires a
configured BuyerSite owner API with the unified database migration applied.
