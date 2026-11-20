import { createHash } from "node:crypto";
import { assertRFQDraft } from "./rfq-contract.mjs";

const fail = (message) => { throw new TypeError(`SUPPLIER_QUOTE: ${message}`); };
const ID = /^[a-z0-9][a-z0-9_-]{7,63}$/i;
const CURRENCY = /^[A-Z]{3}$/;
const TERMS = new Set(["EXW", "FCA", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"]);
const sha = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const bounded = (value, max, field) => {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) fail(`invalid ${field}`);
  return value.trim();
};

export function createSupplierQuoteSubmission({ submissionId, rfq, supplierId, submittedAt, offer }) {
  assertRFQDraft(rfq);
  if (!ID.test(submissionId || "") || !ID.test(supplierId || "")) fail("invalid submission or supplier id");
  if (!Number.isFinite(Date.parse(submittedAt))) fail("invalid submission timestamp");
  if (!offer || typeof offer !== "object" || Array.isArray(offer)) fail("offer is required");

  const currency = bounded(offer.currency, 3, "currency").toUpperCase();
  if (!CURRENCY.test(currency)) fail("currency must be an ISO 4217 code");
  if (!Number.isSafeInteger(offer.unitPriceMinor) || offer.unitPriceMinor <= 0) fail("unit price must be positive integer minor units");
  if (!Number.isSafeInteger(offer.moq) || offer.moq <= 0) fail("MOQ must be a positive integer");
  if (!Number.isSafeInteger(offer.leadTimeDays) || offer.leadTimeDays < 0 || offer.leadTimeDays > 3650) fail("invalid lead time");
  const incoterm = bounded(offer.incoterm, 3, "Incoterm").toUpperCase();
  if (!TERMS.has(incoterm)) fail("unsupported Incoterm");
  const namedPlace = bounded(offer.namedPlace, 160, "named place");
  const validUntil = bounded(offer.validUntil, 40, "validity");
  if (!Number.isFinite(Date.parse(validUntil)) || Date.parse(validUntil) <= Date.parse(submittedAt)) fail("quote validity must be in the future");
  const paymentTerms = offer.paymentTerms == null ? null : bounded(offer.paymentTerms, 500, "payment terms");
  const specificationNotes = offer.specificationNotes == null ? null : bounded(offer.specificationNotes, 2000, "specification notes");

  const snapshot = {
    schemaVersion: 1,
    submissionId,
    tenantId: rfq.tenantId,
    rfqId: rfq.id,
    rfqSnapshotHash: rfq.snapshotHash,
    supplierId,
    submittedAt,
    offer: { currency, unitPriceMinor: offer.unitPriceMinor, moq: offer.moq, leadTimeDays: offer.leadTimeDays,
      incoterm, namedPlace, validUntil, paymentTerms, specificationNotes },
  };
  return {
    schemaVersion: 1,
    id: submissionId,
    tenantId: rfq.tenantId,
    rfqId: rfq.id,
    supplierId,
    status: "received",
    snapshot,
    snapshotHash: sha(JSON.stringify(snapshot)),
  };
}

export function assertSupplierQuoteSubmission(submission) {
  if (!submission || submission.schemaVersion !== 1 || !ID.test(submission.id || "") ||
      submission.id !== submission.snapshot?.submissionId || submission.tenantId !== submission.snapshot?.tenantId ||
      submission.rfqId !== submission.snapshot?.rfqId || submission.supplierId !== submission.snapshot?.supplierId ||
      submission.status !== "received" || sha(JSON.stringify(submission.snapshot)) !== submission.snapshotHash) {
    fail("invalid or modified supplier quote submission");
  }
  return true;
}
