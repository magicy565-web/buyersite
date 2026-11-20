import test from "node:test";
import assert from "node:assert/strict";
import { createSourcingSession, applyRequirementPatch, confirmSourcingSession } from "./session-contract.mjs";
import { createRFQDraft } from "./rfq-contract.mjs";
import { createSupplierQuoteSubmission, assertSupplierQuoteSubmission } from "./supplier-quote-contract.mjs";

const now="2026-11-20T04:00:00.000Z";
const source={siteSlug:"sample-factory",issueId:"issue-2026-11",issueRevision:"sha256:edition",articlePath:"/products/cotton-tote/",allowedArticlePaths:["/products/cotton-tote/"]};
function rfq() {
  let session=createSourcingSession({id:"session_0001",tenantId:"tenant_0001",source,now});
  session=applyRequirementPatch(session,{product:{value:"Cotton tote"},quantity:{value:500},destination:{value:"United States"}},{now,expectedRevision:1});
  session=confirmSourcingSession(session,{now,expectedRevision:2});
  return createRFQDraft({rfqId:"rfq_000001",session,createdAt:now});
}
const offer={currency:"USD",unitPriceMinor:425,moq:500,leadTimeDays:35,incoterm:"FOB",namedPlace:"Ningbo, China",validUntil:"2026-12-20T00:00:00.000Z",paymentTerms:"30% deposit, balance before shipment",specificationNotes:"12 oz cotton canvas"};

test("captures a supplier-submitted immutable quote against one RFQ revision",()=>{
  const result=createSupplierQuoteSubmission({submissionId:"quote_00001",rfq:rfq(),supplierId:"supplier_001",submittedAt:now,offer});
  assert.equal(result.status,"received");
  assert.equal(result.snapshot.offer.unitPriceMinor,425);
  assert.equal(result.snapshot.rfqSnapshotHash,rfq().snapshotHash);
  assert.equal(assertSupplierQuoteSubmission(result),true);
});

test("rejects float prices, missing named place and unsupported terms",()=>{
  assert.throws(()=>createSupplierQuoteSubmission({submissionId:"quote_00001",rfq:rfq(),supplierId:"supplier_001",submittedAt:now,offer:{...offer,unitPriceMinor:4.25}}),/integer minor units/);
  assert.throws(()=>createSupplierQuoteSubmission({submissionId:"quote_00001",rfq:rfq(),supplierId:"supplier_001",submittedAt:now,offer:{...offer,namedPlace:" "}}),/named place/);
  assert.throws(()=>createSupplierQuoteSubmission({submissionId:"quote_00001",rfq:rfq(),supplierId:"supplier_001",submittedAt:now,offer:{...offer,incoterm:"UNKNOWN"}}),/unsupported Incoterm/);
});

test("rejects expired quote validity",()=>{
  assert.throws(()=>createSupplierQuoteSubmission({submissionId:"quote_00001",rfq:rfq(),supplierId:"supplier_001",submittedAt:now,offer:{...offer,validUntil:"2026-11-19T00:00:00.000Z"}}),/must be in the future/);
});

test("tampering with a supplier submission invalidates its hash",()=>{
  const result=createSupplierQuoteSubmission({submissionId:"quote_00001",rfq:rfq(),supplierId:"supplier_001",submittedAt:now,offer});
  result.snapshot.offer.moq=1;
  assert.throws(()=>assertSupplierQuoteSubmission(result),/modified/);
});
