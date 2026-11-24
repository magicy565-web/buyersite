# Merchant support and ChatGPT Business Agent

## Scope and trust boundary

BuyerSite remains the evidence-led editorial and sourcing site. Chatwoot is a separately deployed, supported customer conversation system, not a fork of the Ruby application. A merchant may enable a dedicated Website inbox and connect its native AgentBot (or licensed Captain) to the inbox. BuyerSite does not silently identify a reader, transfer a sourcing conversation, send an enquiry, or claim a business. The independent Material Notes pilot must not be represented as its featured supplier. Private previews never render the support entry.

This PR adds the public, disabled-by-default widget configuration endpoint and a click-to-load widget in the existing layout. It does not provision a Chatwoot account, create an AgentBot, connect a model, deploy a site, submit a business claim or advertise. The owner must explicitly approve the merchant relationship, verify the Website inbox belongs to that merchant, and review the new privacy disclosure.

## Configure one authorized public site

1. Deploy and maintain Chatwoot independently (Community Edition is sufficient for an external AgentBot; Captain requires an eligible paid plan). Use a dedicated merchant account/inbox and approved HTTPS support origin.
2. In Chatwoot, create a Website inbox for the exact merchant website and copy its public Website token. Set a merchant privacy notice, correct branding and support availability. Link the merchant's tested AgentBot in the inbox Bot Configuration. Do not use a different merchant's token.
3. In the BuyerSite Worker environment configure the following server-side settings. No API token or webhook secret belongs in the browser or source repository.

| Setting | Purpose |
| --- | --- |
| BUYERSITE_CHATWOOT_ENABLED | exact true, otherwise disabled |
| BUYERSITE_CHATWOOT_MERCHANT_AUTHORIZED | exact true, owner attests authority to represent named merchant |
| BUYERSITE_CHATWOOT_SITE_SLUG | exact deployed runtime site slug |
| BUYERSITE_CHATWOOT_SITE_ORIGIN | exact public canonical HTTPS origin, no path |
| BUYERSITE_CHATWOOT_BASE_URL | approved Chatwoot HTTPS origin, no path |
| BUYERSITE_CHATWOOT_WEBSITE_TOKEN | public token of the specific Website inbox |
| BUYERSITE_CHATWOOT_MERCHANT_NAME | truthful merchant display name |

The GET /api/buyer/support/config response returns only an enabled flag or the site slug, widget origin, public Website token and display name. The browser loads the vendor SDK only after a click. It does not automatically attach article context, campaign metadata, buyer identity or enquiry data. Switching the enabled flag off removes the entry for new page loads; existing Chatwoot conversations and their retention remain managed in Chatwoot.

## AgentBot backend (next integration, not implemented here)

Use Chatwoot's native AgentBot Webhook with the merchant's separate server-side token/secret, not a public Website token. Validate HMAC-SHA256 over timestamp + "." + raw body, reject stale timestamps, bind account and inbox IDs to the server-configured merchant, deduplicate deliveries/message IDs durably, process only public inbound contact messages for pending conversations, and recheck assignment/status before replying. Return a quick acknowledgement only after durable intake; process asynchronously with retry and a failure queue. Ground answers in that merchant's approved knowledge revision; unknown price, MOQ, stock, certification, delivery or order state must be confirmed by an authorized human or authoritative system. Route human requests, complaints and unresolved commercial commitments to human support. Do not auto-send RFQs or create orders. Verify the exact Chatwoot deployed version and API payload before implementation.

## ChatGPT: separate distribution paths

**Native Business Agent.** The merchant or authorized representative manually opens https://chatgpt.com/business-hub, finds/adds the real merchant, completes the available claim method and Persona identity review, then reviews the agent's information/instructions and publishes it if eligible. Use the merchant's actual controlled domain, correct business identity, approved public product information, policy pages and website support/enquiry links. A DNS TXT record must be copied exactly from Business Hub. No arbitrary agent-discovery file or widget registers a business with OpenAI. Do not upload private Chatwoot transcripts, CRM data, or another merchant's material. ChatGPT's native Business Agent does not expose individual chats to the merchant and does not use a separate ChatGPT plugin's tools. Location, type, industry and verification requirements apply; check the actual merchant's offered workflow. Do not mark a profile claimed or an agent published without official evidence.

**Separate ChatGPT Plugin.** A subsequent independently reviewed MCP integration may offer merchant support tools (e.g. approved public knowledge search, explicitly authorized support conversation creation, message sending, and status retrieval). Use authenticated server-side tenant and conversation mapping, minimal scopes, clear data disclosure and user authorization; keep read and write tools separate. This route may use Chatwoot directly, but is not the native Business Agent or a guarantee of ChatGPT distribution. Do not expose unrestricted Chatwoot account APIs to an anonymous caller.

## Acceptance before public release

- Run node --test runtime/chatwoot-support.test.mjs and the existing complete Node 24 runtime suite.
- Check disabled, wrong origin/tenant, private build, invalid configuration, no secrets, and no third-party requests before an explicit click.
- Use an isolated, merchant-approved Chatwoot Website inbox: open on desktop and 360px mobile, send a labelled test message, receive a real AI reply, transfer to a human, verify the conversation in the correct inbox, and verify no other tenant sees it.
- Re-run the exact-source publication review (the existing fingerprint gate must stay intact). Never change the old review to pass without a fresh review. No production deployment or real buyer messages during this PR.
- For the native agent, retain an owner-approved claim receipt and screenshot of the published agent; test an actual buyer-side question and verify a support website link. No simulated claim status.
- For the separate plugin, independently validate auth, tenant isolation, consent, Chatwoot delivery and submission/review status.

Sources:
- https://www.chatwoot.com/hc/user-guide/articles/1677497472-how-to-use-agent-bots
- https://www.chatwoot.com/hc/user-guide/articles/1677587234-how-to-send-additional-user-information-to-chatwoot-using-sdk
- https://help.openai.com/en/articles/20001635-setting-up-your-business-on-chatgpt
- https://openai.com/policies/business-agents-policy/
