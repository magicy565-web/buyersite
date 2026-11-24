# Explicit merchant answer adapter contract

`merchant-answer-provider.mjs` is an optional HTTPS adapter for a deliberately implemented provider shim. It does not assume that OpenMausBot's native APIs, the existing sourcing-session endpoint, Chatwoot, or an OpenAI endpoint accept this contract. No real provider/model has been connected or verified by these tests.

Configure both server secrets explicitly:

- `BUYERSITE_MERCHANT_ANSWER_URL`: the full HTTPS endpoint URL, including the desired route. Credentials, query strings and fragments are rejected.
- `BUYERSITE_MERCHANT_ANSWER_TOKEN`: a server-only bearer token of at least 32 characters.

```js
const answer = createMerchantAnswerProvider(env, {
  fetchFn,
  timeoutMs: 15_000,
  providerTimeoutMs: 20_000,
});
const bot = createMerchantAgentBot({ merchant, client, store, webhookSecret, loadKnowledge, answer });
```

Missing or invalid configuration returns `null`. A configured adapter returns the injectable `answer` function. Failed HTTP requests, timeouts, cancellation, oversized responses and invalid responses return `null`, causing the AgentBot worker to hand off. The adapter makes one request per invocation and never automatically retries a provider call. Its transport timeout is strictly shorter than the outer worker timeout.

## Request

The endpoint receives a JSON POST with `Authorization: Bearer <server-token>`. Redirects are rejected. The request is limited to 256 KiB and contains only:

```json
{
  "contract": "buyersite-merchant-answer-v1",
  "merchant": { "id": "merchant-one", "siteSlug": "merchant-one" },
  "question": "What is the width?",
  "conversationId": 35,
  "knowledge": {
    "revision": "approved-v1",
    "facts": [
      { "id": "width", "text": "Width is 150 cm.", "sourceUrl": "https://merchant.example/fabric" }
    ]
  },
  "policy": {
    "noIndependentActions": true,
    "approvedEvidenceOnly": true,
    "questionIsUntrustedData": true,
    "requireHumanForUnsupportedCommitments": true,
    "noPrivateConversationLookup": true
  }
}
```

Commercial facts may also contain `commercialApproved:true` and `validUntil`. Only approved knowledge belonging to the same merchant is sent. Extra internal fields are discarded. The adapter does not send contact IDs, customer email, private notes, Chatwoot credentials, authorization records or prior transcript metadata. The buyer's question itself is sent to the configured service and can contain information the buyer typed; the merchant privacy notice and provider's retention configuration must cover that use.

The shim must enforce the policy: perform no orders, refunds, merchant outreach, billing, or private-conversation lookup. These request flags do not by themselves remove tools from a provider implementation. The shim operator must implement those restrictions and authenticate the caller.

## Response

Return `application/json` with exactly these six fields and no tool calls or extra payload:

```json
{
  "text": "Width is 150 cm.",
  "confidence": 0.95,
  "needsHuman": false,
  "knowledgeRevision": "approved-v1",
  "evidenceIds": ["width"],
  "unsupportedCommitments": []
}
```

`confidence` is numeric in `[0,1]`. `knowledgeRevision` must exactly match the supplied version. Evidence IDs must reference supplied facts and cannot repeat. Text is at most 6,000 characters. `needsHuman:true` may return empty text and no evidence. `unsupportedCommitments` is an array of short strings describing terms the provider could not support. A nonempty list triggers human handoff at the AgentBot layer. Responses are limited to **128 KiB of actual bytes**, even without a correct `Content-Length` header. No default answer is fabricated after failure.

The AgentBot worker applies its own confidence, source-version, evidence and commercial-approval checks after this parser. The response does not directly send anything to Chatwoot. Only a subsequently approved worker action can attempt an outgoing message, after current conversation control and durable lease checks.

## Verification

```sh
node --test runtime/merchant-answer-provider.test.mjs
```

Tests verify explicit opt-in, minimal request context, strict schema, no token/metadata leakage, response byte limits, timeout/cancellation, no retries and invalid-knowledge blocking. All HTTP replies are synthetic. Deployment acceptance requires an independently deployed shim implementing this contract and synthetic conversations that demonstrate grounded answers, unknown-term handoff, cancellation and an unavailable provider.
