import test from "node:test";
import assert from "node:assert/strict";
import { createSourcingSession, applyRequirementPatch, confirmSourcingSession } from "./session-contract.mjs";
import { createRFQDraft, assertRFQDraft } from "./rfq-contract.mjs";

const now="2026-11-20T03:30:00.000Z";
const source={siteSlug:"sample-factory",issueId:"issue-2026-11",issueRevision:"sha256:edition",articlePath:"/products/cotton-tote/",allowedArticlePaths:["/products/cotton-tote/"]};
function confirmed() {
  let session=createSourcingSession({id:"session_0001",tenantId:"tenant_0001",source,now});
  session=applyRequirementPatch(session,{
    product:{value:"Cotton tote bag"},
    quantity:{value:500},
    destination:{value:"United States"},
    incoterm:{value:"FOB Ningbo"},
  },{now,expectedRevision:1});
  return confirmSourcingSession(session,{now,expectedRevision:2});
}

test("creates a source-bound RFQ draft only from a buyer-confirmed session",()=>{
  const rfq=createRFQDraft({rfqId:"rfq_000001",session:confirmed(),createdAt:now});
  assert.equal(rfq.status,"draft");
  assert.equal(rfq.snapshot.source.articlePath,source.articlePath);
  assert.equal(rfq.snapshot.requirements.quantity.value,500);
  assert.equal(rfq.sentAt,null);
  assert.deepEqual(rfq.supplierIds,[]);
  assert.equal(assertRFQDraft(rfq),true);
});

test("refuses an unconfirmed session",()=>{
  const session=createSourcingSession({id:"session_0001",tenantId:"tenant_0001",source,now});
  assert.throws(()=>createRFQDraft({rfqId:"rfq_000001",session,createdAt:now}),/buyer-confirmed/);
});

test("refuses model-only or unconfirmed requirement provenance",()=>{
  const session=confirmed();
  const changed=structuredClone(session);
  changed.requirements.product.provenance="buyer-stated";
  assert.throws(()=>createRFQDraft({rfqId:"rfq_000001",session:changed,createdAt:now}),/unconfirmed requirement/);
});

test("snapshot hash detects edits to commercial requirements",()=>{
  const draft=createRFQDraft({rfqId:"rfq_000001",session:confirmed(),createdAt:now});
  draft.snapshot.requirements.quantity.value=5000;
  assert.throws(()=>assertRFQDraft(draft),/hash mismatch/);
});

test("RFQ draft never fabricates supplier routing or sends a quote request",()=>{
  const draft=createRFQDraft({rfqId:"rfq_000001",session:confirmed(),createdAt:now});
  assert.deepEqual(draft.supplierIds,[]);
  assert.equal(draft.sentAt,null);
  assert.equal(draft.status,"draft");
});
