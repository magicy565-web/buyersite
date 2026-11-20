import test from "node:test";
import assert from "node:assert/strict";
import {
  createSourcingSession, applyRequirementPatch, getMissingRequiredFields,
  getOptionalFollowUps, confirmSourcingSession, markSourcingSessionHandedOff,
} from "./session-contract.mjs";

const NOW = "2026-11-20T03:00:00.000Z";
const source = {
  siteSlug: "sample-factory",
  issueId: "issue-2026-11",
  issueRevision: "sha256:abc123",
  articlePath: "/products/cotton-tote/",
  allowedArticlePaths: ["/products/cotton-tote/", "/guides/cotton-tote/"],
};
const make = () => createSourcingSession({ id:"session_0001", tenantId:"tenant_0001", source, now:NOW });

test("creates a source-bound session without inventing buyer requirements", () => {
  const session = make();
  assert.equal(session.status, "collecting");
  assert.deepEqual(session.requirements, {});
  assert.equal(getMissingRequiredFields(session).length, 3);
});

test("rejects article paths not present in the frozen issue", () => {
  assert.throws(() => createSourcingSession({
    id:"session_0001", tenantId:"tenant_0001",
    source:{...source, articlePath:"/products/other-product/"}, now:NOW,
  }), /not in the frozen issue/);
});

test("accepts partial answers and asks only for missing required fields", () => {
  const next = applyRequirementPatch(make(), {
    product:{value:"Cotton tote bag"},
    quantity:{value:500},
  }, {now:NOW, expectedRevision:1});
  assert.equal(next.status, "collecting");
  assert.deepEqual(getMissingRequiredFields(next).map(x=>x.field), ["destination"]);
  assert.equal(getOptionalFollowUps(next).length, 5);
});

test("moves to confirmation only after all required fields are present", () => {
  let session = applyRequirementPatch(make(), {
    product:{value:"Cotton tote bag"},
    quantity:{value:500},
    destination:{value:"United States"},
  }, {now:NOW, expectedRevision:1});
  assert.equal(session.status, "ready_for_confirmation");
  session = confirmSourcingSession(session, {now:NOW, expectedRevision:2});
  assert.equal(session.status, "confirmed");
  assert.equal(session.requirements.product.provenance, "buyer-confirmed");
});

test("rejects stale revisions and concurrent overwrites", () => {
  const session = applyRequirementPatch(make(), {product:{value:"Cotton tote bag"}}, {now:NOW, expectedRevision:1});
  assert.throws(() => applyRequirementPatch(session, {quantity:{value:100}}, {now:NOW, expectedRevision:1}), /revision conflict/);
});

test("does not allow model provenance to masquerade as buyer confirmation", () => {
  assert.throws(() => applyRequirementPatch(make(), {
    product:{value:"Cotton tote bag", provenance:"verified-by-model"},
  }, {now:NOW, expectedRevision:1}), /invalid provenance/);
});

test("cannot hand off an unconfirmed session to RFQ", () => {
  const session = applyRequirementPatch(make(), {
    product:{value:"Cotton tote bag"}, quantity:{value:500}, destination:{value:"United States"},
  }, {now:NOW, expectedRevision:1});
  assert.throws(() => markSourcingSessionHandedOff(session, {
    rfqId:"rfq_000001", expectedRevision:2, now:NOW,
  }), /buyer confirmation required/);
});

test("confirmed brief can be handed off once with a stable RFQ reference", () => {
  let session = applyRequirementPatch(make(), {
    product:{value:"Cotton tote bag"}, quantity:{value:500}, destination:{value:"United States"},
  }, {now:NOW, expectedRevision:1});
  session = confirmSourcingSession(session, {now:NOW, expectedRevision:2});
  session = markSourcingSessionHandedOff(session, {rfqId:"rfq_000001", expectedRevision:3, now:NOW});
  assert.equal(session.status, "handed_off");
  assert.equal(session.rfqId, "rfq_000001");
});

test("rejects non-positive quantities and arbitrary field injection", () => {
  assert.throws(() => applyRequirementPatch(make(), {quantity:{value:0}}, {now:NOW, expectedRevision:1}), /invalid quantity/);
  assert.throws(() => applyRequirementPatch(make(), {internalCost:{value:"$2"}}, {now:NOW, expectedRevision:1}), /unknown requirement field/);
});
