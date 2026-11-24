# Approved merchant knowledge and Business Hub evidence

This module persists the public facts that a particular merchant has authorized
for a particular BuyerSite. It also prepares a manual Business Hub setup pack
and records an authenticated owner's observations of the external setup process.
It does not register a Chatwoot agent with OpenAI or certify an OpenAI approval.

## Trust boundary

Construct each repository from server configuration, after resolving the site:

```js
const merchant = {
  merchantId: 'merchant-one',
  siteSlug: 'edition-one',
  name: 'Example Merchant',
  origin: 'https://merchant.example',
  privacyUrl: 'https://merchant.example/privacy',
  authorizationRef: 'grant:merchant-one:2026-11',
  // knowledgeRevision: '<optional SHA-256 version pin>',
};
```

The example business and domains above are synthetic. Production configuration
must identify the actual authorized merchant. `authorizationRef` refers to an
operator-held authorization record; it is not an API secret and is not proof
that this module independently inspected that record.

The HTTP layer must authenticate the owner, derive `actorId` from the verified
session, and check authorization for this exact site and merchant before calling
any mutation. A nonempty `actorId` is an attribution requirement, not an
authentication mechanism. Never construct the binding, actor, clock, or active
knowledge revision from buyer tool arguments or an untrusted request body.

All database queries include both `site_slug` and `merchant_id`. Immutable
knowledge also includes a digest of the server binding. Changing the origin,
merchant identity, privacy URL, or authorization reference makes earlier
knowledge and claim state fail closed until an operator reconciles them. The
optional version pin must match the active version.

Editorial publication permission does not prove the supplier authorized an
agent to represent it. Importing an existing editorial knowledge file is an
explicit owner operation with a separately configured merchant authorization.
Private enterprise memory, account records, support conversations, and internal
notes must not be copied into the public facts.

## Knowledge API

`createMerchantKnowledgeRepository(db, merchant)` accepts a D1-compatible binding
with `prepare().bind().first()` and `.run()` methods. Its methods are:

| Method | Result and constraint |
| --- | --- |
| `saveVersion(input, { actorId, now? })` | Saves a content-addressed immutable version; returns `{ revision, fact_count, excluded_count, activated: false }`. |
| `activateVersion(revision, { expectedRevision, actorId, now? })` | Publishes the saved version using compare-and-swap; returns `{ revision, generation, activated: true }`. Use `expectedRevision: null` only for the first activation. |
| `getActive({ now? }?)` | Returns the current public projection, or `null` when no version has been activated. |
| `getVersion(revision, { now? }?)` | Returns a specific version's current public projection, or `null` if that version does not exist in this binding. |
| `search(query, { limit?, now? }?)` | Searches only persisted, active, current facts. The default limit is 5 and the maximum is 10. |

`input` accepts only `facts` and optional `source_revision`. Each accepted fact
has this shape:

```json
{
  "evidence_id": "fabric-composition",
  "merchant_id": "merchant-one",
  "kind": "product",
  "claim": "Fabric composition",
  "value": "100% wool",
  "source_url": "https://merchant.example/fabric#specification",
  "captured_at": "2026-11-20T00:00:00.000Z",
  "valid_until": null,
  "status": "merchant-confirmed",
  "audience": "public",
  "publication_permission": "approved"
}
```

This is a synthetic schema example, not an offer or a product fact suitable for
publishing unchanged. Permitted kinds are `general`, `product`, `policy`,
`price`, `availability`, `moq`, `lead_time`, and `certification`. The last five
require `valid_until`. Permitted source-status labels are `supplier-stated`,
`merchant-confirmed`, and `independently-verified`; the importing owner is
responsible for substantiating the selected label.

Facts from a different merchant reject the whole upload. Facts without both
`audience: "public"` and `publication_permission: "approved"` are excluded.
Only the fields shown above are stored in the public version; extra source
fields, internal notes, and customer data are discarded. A bundle permits at
most 1,000 input facts and 512,000 UTF-8 bytes after projection. Every accepted
fact needs a unique evidence identifier, an HTTPS source citation, and a capture
time that has already occurred. Credentials and local network URLs are rejected.

Reads exclude facts before their capture time and at or after their expiry time.
Activation rejects a version with no currently valid facts. Search performs
deterministic lexical matching and returns the stored claims, values, source
URLs, and dates without generating new claims or prices. Source citations are
validated URLs; values and claims retain their supplied content with outer
whitespace trimmed.

`getActive()` and `getVersion()` return:

```js
{
  schema_version: 'merchant-knowledge-v1',
  merchant_id, site_slug, merchant_name, merchant_origin,
  revision, effective_at, facts,
  inference_performed: false,
}
```

`search()` returns `{ merchant_id, site_slug, revision, effective_at, results,
inference_performed: false }`. Without an active version, `revision` is `null`
and `results` is empty. There is no fallback to enterprise-wide or another
merchant's knowledge. Ownership metadata and authorization digests are excluded
from these public projections.

Publication is a deliberate two-step operation:

```js
const knowledge = createMerchantKnowledgeRepository(env.DB, merchant);
const current = await knowledge.getActive();
const saved = await knowledge.saveVersion(ownerApprovedInput, { actorId });
await knowledge.activateVersion(saved.revision, {
  actorId,
  expectedRevision: current?.revision ?? null,
});
```

On a `409` revision conflict, read the current version and have the owner review
the competing publication. Do not silently retry against a newer revision.
Identical normalized content reuses the same version; existing content cannot
be updated through this API or the schema's update trigger.

## Claim evidence API

`createMerchantOnboardingRepository(db, merchant)` additionally requires D1's
atomic `batch()` method. It provides `get()`, `recordEvidence()`, and
`preparePack()`.

`get()` returns an initial revision of `0` or the persisted state. It always
includes `status_origin: "owner_recorded"`, `platform_verified: false`, and
`native_chatwoot_bridge: false`. The reported claim, Persona, and agent states
are explicitly the owner's observations. An input such as `claimed: true` or
`platform_verified: true` is rejected.

Evidence accepts only these fields:

```js
{
  event_id: '<UUID v4>',
  kind: 'claim_approved',
  artifact_ref: 'redacted:proof-1',
  artifact_sha256: '<SHA-256 of an operator-retained evidence artifact>',
  observed_at: '<ISO timestamp>',
  official_url: 'https://chatgpt.com/business-hub',
  // knowledge_revision: '<required for preview or publication>',
  // agent_url: '<actual chatgpt.com agent URL; required for publication>',
}
```

Store only opaque redacted artifact references and their checksums here. The
module does not fetch the artifacts, validate their bytes, inspect identity
documents, or compare them with OpenAI's live state. A checksum alone does not
establish authenticity. The authorized operator must retain and review the
actual evidence outside the public knowledge store. Do not include identity
documents, verification tokens, or personal data in the reference.

Permitted events are `claim_submitted`, `claim_approved`, `claim_rejected`,
`persona_submitted`, `persona_approved`, `persona_rejected`,
`agent_preview_passed`, `agent_published`, and `agent_unavailable`.
Persona events require recorded claim approval. Preview and publication require
both recorded approvals. Publication also requires a recorded preview of the
same active knowledge version and the actual agent link. A reported rejection
or renewed submission clears dependent progress. No event can turn this local
state into an official verification.

```js
const onboarding = createMerchantOnboardingRepository(env.DB, merchant);
const current = await onboarding.get();
const active = await knowledge.getActive();
const receipt = await onboarding.recordEvidence(ownerEvidence, {
  actorId,
  expectedRevision: current.revision,
  activeKnowledgeRevision: active?.revision ?? null,
});
```

`activeKnowledgeRevision` must come from the server repository. `expectedRevision`
is the owner-visible integer used for compare-and-swap. A successful call returns
the evidence, immutable receipt, resulting state, and `replay: false`. Repeating
the same event ID and payload for the same actor returns the existing receipt
with `replay: true`; changing that payload returns `409`. Claim state, receipt,
and evidence insertion share one atomic D1 batch. Binding revocation blocks
receipt replay as well as ordinary reads.

## Preparing the manual setup pack

```js
const pack = await onboarding.preparePack(await knowledge.getActive());
```

The input must be the server-read repository projection. The lower-level
`prepareBusinessHubPack(merchant, knowledge, state?, options?)` is a formatting
helper, not an authorization or evidence-verification endpoint. Do not expose
it with request-supplied knowledge or state.

The pack includes the real configured merchant identity, current approved facts
and original citations, grounded agent instructions, the knowledge revision,
owner-recorded progress, and links to the official setup and schema references.
It reports whether recorded preview evidence matches this knowledge version.
There is no network submission and no automatic registration or publishing.

The public [Business Hub setup documentation](https://help.openai.com/en/articles/20001635-setting-up-your-business-on-chatgpt)
describes business-claim and Persona approval separately. Agent availability
and publishing are further steps in the official interface. Native Business
Agents do not inherit a separate plugin's data or capabilities, and businesses
do not receive individual customer conversations. The documented setup does
not provide a third-party Chatwoot registration API; that is a limitation of
the documented integration surface, not a claim about private partner access.
Eligibility must be checked in the real Business Hub flow for the business's
location, type, and available verification method.

The [Business Agents Policy](https://openai.com/policies/business-agents-policy/)
requires an authorized representative and accurate business information. The
[Businesses in ChatGPT policy](https://openai.com/policies/businesses-in-chatgpt/)
governs the business profile. Treat these official policies and the live setup
interface as authoritative when completing the manual steps.

The pack deliberately reports `product_feed.generated: false`. The official
[product feed schema](https://developers.openai.com/commerce/specs/file-upload/products)
requires real product identity, offer, image, availability, price, and country
fields. An editorial article or a request-for-quotation inquiry does not supply
those records. Missing prices, licensed images, or current offers must be
obtained from the merchant; no placeholder values are manufactured.

## Migration and verification

`runtime/merchant-knowledge.schema.sql` defines four scoped tables and two
immutability triggers. Integrate it into the project's next unified migration;
do not independently apply it to production. The module does not change the
Drizzle migration journal or existing migrations.

Run the focused suite with Node 22.12 or later with `node:sqlite` support:

```sh
node --test runtime/merchant-knowledge.test.mjs runtime/merchant-onboarding.test.mjs
```

The tests execute the actual SQLite statements through a D1-shaped test adapter.
They cover persisted version reopening, immutable records, tenant and merchant
isolation, authorization binding changes, exact citations, approval filtering,
expiry, competing updates, idempotency, state prerequisites, and absence of
fabricated offer fields. They do not establish live OpenAI approval, Chatwoot
connectivity, production D1 deployment, or business eligibility; those require
the separate integration and operator acceptance steps.
