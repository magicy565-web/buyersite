# Merchant Chatwoot runtime

`merchant-chatwoot.mjs` is a server-only account/inbox-bound client. `merchant-agentbot.mjs` separates authenticated webhook intake from durable asynchronous answer work. No file in this module registers a route, applies a migration during a request, enables a merchant automatically, or supplies a live AI connection.

## Server binding and credentials

The integration supplies a server-owned binding:

```js
const merchant = {
  merchantId: 'merchant-one',
  siteSlug: 'merchant-one',
  name: 'Example Merchant',
  origin: 'https://merchant.example',
  privacyUrl: 'https://merchant.example/privacy',
  authorizationRef: 'verified-merchant-authorization-record',
  chatwoot: {
    baseUrl: 'https://support.example',
    accountId: 8,
    websiteInboxId: 20,
    apiInboxId: 21,
  },
};
```

The account, inboxes, merchant authorization and origin never come from a buyer's message or a tool's parameters. `baseUrl` must be an HTTPS origin without credentials, path, query or fragment. Website and API inboxes must be distinct. Either may be omitted if the deployment only uses the other channel; private conversation creation and incoming writes require `apiInboxId`.

Use an appropriately scoped Chatwoot service-user API token for contact creation, API-channel incoming messages and message history. Use a separate AgentBot token for outgoing bot messages and pending-to-open handoff. Current Chatwoot accepts `Authorization: Bearer …`; its AgentBot endpoint allowlist does not include contact creation or message history. Credentials and webhook secrets remain in server secrets and are never included in returned message data.

The caller must also bind a private conversation to its authenticated buyer and check that ownership before passing any conversation ID to this client. This client checks the merchant/account/inbox and an optional `contactId`; it does not implement end-user OAuth or conversation ownership.

## Client contract

```js
const client = createMerchantChatwootClient({
  merchant, apiToken, agentBotToken, fetchFn,
});
```

| Method | Input | Result / behavior |
| --- | --- | --- |
| `createContact` | `{identifier,name?,email?}` | `{id,sourceId}` from the API inbox's contact association. Use an opaque server-owned identifier. |
| `createConversation` | `{contactId,sourceId,message?}` | Normalized conversation. Optional message is a string or `{content}` and is created atomically in Chatwoot's native conversation transaction as `incoming`. |
| `getConversation` | `{conversationId,contactId?,asAgent?}` | Normalized conversation after account, inbox and optional contact checks. |
| `sendIncoming` | `{conversationId,content,sourceId?,contactId?}` | Normalized incoming message. Rechecks the conversation and requires the API inbox. |
| `listPublicMessages` | `{conversationId,after?,before?,contactId?}` | `{messages,nextCursor}`. Ascending message IDs; private, activity and template messages are excluded. `after:0` begins incremental pagination. |
| `sendAgentReply` | `{conversationId,content,inReplyTo,sourceId?,expectedAgentBotId?,beforeSend?}` | Normalized outgoing message. Requires pending state, no human assignment, matching assigned AgentBot when present, and a successful optional final control callback. |
| `requestHuman` | `{conversationId,contactId?}` | `{status,handedOff}`. Explicitly sets a pending conversation to `open`; already-open/resolved/snoozed states are left alone. |

A normalized conversation includes `id`, `accountId`, `inboxId`, `contactId`, `status`, `assigneeType`, `assigneeId`, `messages`, and compatibility aliases `account_id`, `inbox_id`, `contact_id`, `meta.sender.id`, `meta.assignee_type`, `meta.assignee.id`. The conversation-detail endpoint contains only the latest message, with the latest non-activity message when available; it is not complete history. Use `listPublicMessages` for history and page until the cursor stops advancing. Chatwoot currently returns up to 100 messages after an ID, or 20 when fetching the latest/before an ID.

Normalized public messages include `id`, `content`, `message_type` and `direction` (`incoming`/`outgoing`), `private:false`, native `created_at`, ISO `createdAt`, and a minimal `sender:{type}`. The adapter does not expose private notes, contact email, source IDs, attachment URLs, access tokens or arbitrary Chatwoot metadata. Attachment content is not supported in this text-only release.

Mutations are attempted once. `ChatwootClientError` exposes a stable `code`, optional HTTP `status`, and `ambiguous`. Network failures, uncertain server responses and malformed successful write responses have `ambiguous:true`. A timeout or `source_id` does not establish whether Chatwoot created the message. The caller must retain a durable operation record and reconcile ambiguous outcomes instead of resending blindly.

## Durable AgentBot intake and jobs

Apply `merchant-agentbot.schema.sql` as part of the integration's versioned database migration. It defines `merchant_agentbot_jobs`; it is not executed by the module.

```js
const store = createD1MerchantAgentBotStore(env.DB);
const bot = createMerchantAgentBot({
  merchant,
  webhookSecret,
  store,
  client,
  agentBotId: 12,
  answer,                   // Optional injected provider; absent means human handoff.
  loadKnowledge,            // Optional approved merchant knowledge loader.
  canAutomate: conversationId => support.canAutomate(conversationId),
});

await bot.intake(request);  // Authenticates and durably queues only; no reply is sent here.
await bot.processNext();   // Run from the integration's authenticated worker/scheduler.
```

Intake verifies `X-Chatwoot-Signature: sha256=<HMAC hex>` over exactly `X-Chatwoot-Timestamp + '.' + raw request bytes`, using SHA-256 HMAC and the AgentBot signing secret. Timestamp units are seconds. The default permitted skew is 300 seconds. Verification occurs before JSON parsing; the body limit is 128 KiB. A deployment using old Chatwoot without signed AgentBot webhooks must upgrade or provide a separately authenticated gateway. There is no unsigned fallback.

Only public incoming `message_created` events from the bound account and inbox become jobs. Sender contact ID must match the conversation contact. Outgoing/private/status events are acknowledged without starting another answer. Payloads retain the buyer's message and minimal routing context; contact names/emails, arbitrary metadata and attachment URLs are not retained. The deployment's transcript retention/deletion controls must cover these job rows and candidate answers.

Successful durable insert returns 202. A replay with a different delivery ID still deduplicates by site/merchant/Chatwoot-origin/account/inbox/message ID. Claim, lease recovery, status updates and operator access use the same server-owned scope, so another edition or an old instance/account/inbox binding cannot be claimed or dead-lettered merely because its merchant ID matches. Numeric IDs can be reused by a different Chatwoot instance, so the HTTPS origin is part of the durable scope too. The canonical minimal payload hash detects a reused message ID with changed content. Failed storage returns **500**, because current Chatwoot AgentBot retry logic specifically retries 429 and 500. Intake performs no model calls and should complete inside Chatwoot's default five-second webhook timeout. Provision one automatic answer runtime for each Chatwoot inbox; subscribing the same inbox to independent runtimes is not cross-runtime deduplication.

Claim uses an atomic SQLite update. Jobs for one conversation execute in order; independent conversations can execute concurrently. A lease token prevents a stale worker from claiming its successor's right to send. A pre-send processing crash is reclaimable. A crash after durable transition to `sending` becomes `unknown` after lease expiry, and blocks subsequent automatic replies in that conversation. An explicit uncertain HTTP result also becomes `unknown` immediately.

`processNext()` reports `idle`, `delivered`, `handed_off`, `ignored`, `retry`, `dead`, `unknown` or `lease_lost`. It records evidence IDs and approved knowledge revision with a prepared answer before attempting the outgoing API call. `source_id: buyersite-agentbot:<job-id>` is diagnostic correlation, not a server idempotency key.

Jobs older than 24 hours by their durable receipt timestamp hand off without a model call, so a resumed worker does not send old automatic replies after an extended outage. `maxJobAgeMs` may be configured from one second to seven days. The webhook's `created_at` cannot extend the age limit; a durable timestamp more than five minutes in the future also fails closed to handoff.

## Answer and knowledge contracts

The injected loader receives `{merchant,message,conversation,signal}` and returns:

```js
{
  approved: true,
  merchantId: 'merchant-one',
  revision: 'approved-knowledge-v1',
  facts: [{
    id: 'fact-width',
    text: 'Published width is 150 cm.',
    sourceUrl: 'https://merchant.example/fabric',
    // A commercial quote additionally needs:
    // commercialApproved: true,
    // validUntil: '2026-12-01T00:00:00Z',
  }],
}
```

The answer provider receives `{merchant,message,conversation,knowledge,signal}` and returns:

```js
{
  text: 'Published width is 150 cm.',
  confidence: 0.96,
  needsHuman: false,
  knowledgeRevision: 'approved-knowledge-v1',
  evidenceIds: ['fact-width'],
  unsupportedCommitments: [],
}
```

The adapter must not give the model independent order, refund, merchant messaging, billing or account-management tools. Buyer text is untrusted data. A provider's structured confidence and evidence fields are gating signals, not proof of correctness; the merchant still needs versioned approved source facts and evaluation against real support examples.

The worker hands off when no provider is configured, knowledge is absent/unapproved, attachments need review, the provider times out/fails, confidence is below 0.8, evidence/version is missing, or commercial claims lack approval. The bounded provider timeout defaults to 20 seconds and accepts an abort signal. Commercial language in either the question or proposed answer triggers the stricter rule: the complete answer must exactly equal a current `commercialApproved` fact. Otherwise the human receives the conversation. This conservative text gate is not a complete semantic classifier for every language.

The current Chatwoot conversation is checked before generation and again before sending. The local durable `canAutomate` flag is checked before generation, after generation, and inside the client's final pre-POST callback together with the lease. That final callback reloads the approved knowledge, requires the active revision to match, and reruns evidence and commercial-expiry checks against the current projection. A revision change or unavailable/revoked fact vetoes the outgoing POST and hands off. It fails closed when knowledge or control storage errors. A human-assigned/open conversation stops the bot. Chatwoot currently offers no atomic “send only if still pending” message API: a concurrent action in the remote Chatwoot UI between its final GET and POST remains a narrow race. The runtime does not claim that cross-system race is eliminated.

## Manual reconciliation and operations

`store.get({...scope,jobId})` retrieves the durable internal record. The scope is `{merchantId,siteSlug,chatwootOrigin,accountId,inboxIds:[websiteInboxId,apiInboxId]}` with unconfigured IDs omitted. An authenticated operator must inspect the Chatwoot conversation and correlation field before resolving `unknown` or `dead`:

```js
await store.reconcile({
  ...scope,
  jobId,
  resolution: 'delivered', // Or 'handed_off' / 'ignored' with externally verified reason.
  sentMessageId: verifiedMessageId,
  reason: 'Verified the existing message in the Chatwoot conversation',
});
```

`delivered` requires a concrete message ID. Reconciliation does not requeue a potentially delivered answer. Keep this API behind operator authentication and an audit record; the module does not register a public reconciliation route. Monitor queue age, unknown/dead counts, repeated webhook 500s and handoff failures. Do not log provider content, access tokens or raw webhook contact metadata into general request logs.

## Verification and official contracts

The focused tests use mock HTTP responses and real on-disk SQLite with reopen checks:

```sh
node --test runtime/merchant-chatwoot.test.mjs runtime/merchant-agentbot.test.mjs
```

They verify tenant/contact isolation, secret/signature handling, HMAC byte integrity, no loop from outgoing/private events, durable deduplication, concurrent claims, lost leases, uncertain delivery quarantine, public-history filtering, API-channel incoming messages, bot-token replies, local/remote handoff checks and conservative provider gating. They make no live merchant requests or model calls. Production acceptance still requires the deployed Chatwoot version, token scopes, signed AgentBot subscription, worker scheduling and provider contract to be configured and tested with synthetic conversations.

Official sources were checked against Chatwoot commit `576e4f88cd3e5e312ce8fff73b04643e44726ffd` (2026-11-23):

- [AgentBot lifecycle and setup](https://www.chatwoot.com/hc/user-guide/articles/1677497472-how-to-use-agent-bots).
- [Webhook signing documentation](https://www.chatwoot.com/hc/user-guide/articles/1677693021-how-to-use-webhooks).
- [Actual HMAC signing, timeout and AgentBot retry statuses](https://github.com/chatwoot/chatwoot/blob/576e4f88cd3e5e312ce8fff73b04643e44726ffd/lib/webhooks/trigger.rb).
- [AgentBot event dispatch, signing secret and delivery ID](https://github.com/chatwoot/chatwoot/blob/576e4f88cd3e5e312ce8fff73b04643e44726ffd/app/listeners/agent_bot_listener.rb).
- [MessageBuilder incoming restriction and outgoing default](https://github.com/chatwoot/chatwoot/blob/576e4f88cd3e5e312ce8fff73b04643e44726ffd/app/builders/messages/message_builder.rb).
- [Native conversation creation and explicit handoff](https://github.com/chatwoot/chatwoot/blob/576e4f88cd3e5e312ce8fff73b04643e44726ffd/app/controllers/api/v1/accounts/conversations_controller.rb).
- [Token authentication and AgentBot endpoint allowlist](https://github.com/chatwoot/chatwoot/blob/576e4f88cd3e5e312ce8fff73b04643e44726ffd/app/controllers/concerns/access_token_auth_helper.rb).
- [Webhook display-ID presenter](https://github.com/chatwoot/chatwoot/blob/576e4f88cd3e5e312ce8fff73b04643e44726ffd/app/presenters/conversations/event_data_presenter.rb).
- [Conversation response and latest-message semantics](https://github.com/chatwoot/chatwoot/blob/576e4f88cd3e5e312ce8fff73b04643e44726ffd/app/views/api/v1/conversations/partials/_conversation.json.jbuilder).
- [Message pagination and internal-message filtering](https://github.com/chatwoot/chatwoot/blob/576e4f88cd3e5e312ce8fff73b04643e44726ffd/app/finders/message_finder.rb).

Two source details are deliberately covered in tests: the native initial `message` defaults to outgoing unless `message_type:'incoming'` is supplied; the AgentBot handoff code leaves `payload.success` null, so confirmed `current_status:'open'` and the correct conversation ID are used as the receipt.
