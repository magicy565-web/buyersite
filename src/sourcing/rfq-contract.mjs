import { createHash } from "node:crypto";
import { assertSourcingSession } from "./session-contract.mjs";

const fail = (message) => { throw new TypeError(`SOURCING_RFQ: ${message}`); };
const ID = /^[a-z0-9][a-z0-9_-]{7,63}$/i;
const REQUIRED = ["product", "quantity", "destination"];
const OPTIONAL = ["specification", "customization", "target_date", "incoterm", "sample"];
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

export function createRFQDraft({ rfqId, session, createdAt = new Date().toISOString() }) {
  assertSourcingSession(session);
  if (!ID.test(rfqId || "")) fail("invalid RFQ id");
  if (session.status !== "confirmed") fail("buyer-confirmed sourcing session required");
  if (!Number.isFinite(Date.parse(createdAt))) fail("invalid creation timestamp");

  const requirements = {};
  for (const field of [...REQUIRED, ...OPTIONAL]) {
    const entry = session.requirements[field];
    if (!entry || entry.value == null) {
      if (REQUIRED.includes(field)) fail(`missing required field: ${field}`);
      continue;
    }
    if (!["buyer-confirmed", "source-derived"].includes(entry.provenance)) {
      fail(`unconfirmed requirement: ${field}`);
    }
    requirements[field] = { value: entry.value, provenance: entry.provenance, updatedAt: entry.updatedAt };
  }
  if (!Number.isSafeInteger(requirements.quantity?.value) || requirements.quantity.value <= 0) fail("invalid quantity");

  const snapshot = {
    schemaVersion: 1,
    rfqId,
    tenantId: session.tenantId,
    buyerId: session.buyerId,
    source: {
      siteSlug: session.source.siteSlug,
      issueId: session.source.issueId,
      issueRevision: session.source.issueRevision,
      articlePath: session.source.articlePath,
    },
    requirements,
    createdAt,
    sourceSessionId: session.id,
    sourceSessionRevision: session.revision,
  };
  const canonical = JSON.stringify(snapshot);
  return {
    schemaVersion: 1,
    id: rfqId,
    tenantId: session.tenantId,
    sourceSessionId: session.id,
    sourceSessionRevision: session.revision,
    status: "draft",
    snapshot,
    snapshotHash: sha256(canonical),
    createdAt,
    sentAt: null,
    supplierIds: [],
  };
}

export function assertRFQDraft(rfq) {
  if (!rfq || rfq.schemaVersion !== 1 || !ID.test(rfq.id || "") ||
      rfq.id !== rfq.snapshot?.rfqId || rfq.tenantId !== rfq.snapshot?.tenantId ||
      rfq.status !== "draft" || rfq.sentAt !== null || !Array.isArray(rfq.supplierIds) ||
      rfq.supplierIds.length !== 0) fail("invalid RFQ draft envelope");
  const canonical = JSON.stringify(rfq.snapshot);
  if (sha256(canonical) !== rfq.snapshotHash) fail("RFQ snapshot hash mismatch");
  if (!rfq.snapshot.source?.articlePath || !rfq.snapshot.source.issueId ||
      !rfq.snapshot.sourceSessionId || !Number.isSafeInteger(rfq.snapshot.sourceSessionRevision) || rfq.snapshot.sourceSessionRevision < 1) fail("missing source lineage");
  for (const field of REQUIRED) {
    if (!rfq.snapshot.requirements?.[field]) fail(`missing required RFQ field: ${field}`);
  }
  return true;
}
