const VERSION = 1;
const ID = /^[a-z0-9][a-z0-9_-]{7,63}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ARTICLE_PATH = /^\/(products|suppliers|guides)\/[a-z0-9]+(?:-[a-z0-9]+)*\/$/;
const MAX_VALUE = 1200;

export const SOURCING_FIELDS = Object.freeze({
  product: { required: true, label: "Product or product family", kind: "text" },
  quantity: { required: true, label: "Target quantity", kind: "positive-integer" },
  destination: { required: true, label: "Destination market", kind: "text" },
  specification: { required: false, label: "Required specifications", kind: "text" },
  customization: { required: false, label: "Customization", kind: "text" },
  target_date: { required: false, label: "Target delivery date", kind: "date-or-text" },
  incoterm: { required: false, label: "Trade term and named place", kind: "text" },
  sample: { required: false, label: "Sample requirement", kind: "text" },
});

const fail = (message) => { throw new TypeError(`SOURCING_SESSION: ${message}`); };
const text = (value, max = MAX_VALUE) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= max;
const clone = (value) => structuredClone(value);

function validateSource(source) {
  if (!source || !SLUG.test(source.siteSlug || "") || !SLUG.test(source.issueId || "") ||
      !ARTICLE_PATH.test(source.articlePath || "")) fail("invalid source context");
  if (!Array.isArray(source.allowedArticlePaths) ||
      !source.allowedArticlePaths.includes(source.articlePath)) fail("article is not in the frozen issue");
  return {
    siteSlug: source.siteSlug,
    issueId: source.issueId,
    articlePath: source.articlePath,
    issueRevision: text(source.issueRevision, 128) ? source.issueRevision : null,
  };
}

function validateValue(field, value) {
  const rule = SOURCING_FIELDS[field];
  if (!rule) fail("unknown requirement field");
  if (value === null) return null;
  if (rule.kind === "positive-integer") {
    if (!Number.isSafeInteger(value) || value <= 0) fail(`invalid ${field}`);
    return value;
  }
  if (!text(value)) fail(`invalid ${field}`);
  const normalized = value.trim();
  if (rule.kind === "date-or-text" && /^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    const date = new Date(`${normalized}T00:00:00.000Z`);
    if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== normalized) fail("invalid target_date");
  }
  return normalized;
}

export function createSourcingSession({ id, tenantId, buyerId = null, source, now = new Date().toISOString() }) {
  if (!ID.test(id || "") || !ID.test(tenantId || "")) fail("invalid session or tenant id");
  if (buyerId !== null && !ID.test(buyerId)) fail("invalid buyer id");
  if (!text(now, 40) || !Number.isFinite(Date.parse(now))) fail("invalid created timestamp");
  return {
    schemaVersion: VERSION,
    id,
    tenantId,
    buyerId,
    source: validateSource(source),
    status: "collecting",
    requirements: {},
    turns: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    confirmedAt: null,
    rfqId: null,
  };
}

export function assertSourcingSession(session) {
  if (!session || session.schemaVersion !== VERSION || !ID.test(session.id || "") ||
      !ID.test(session.tenantId || "") || !Number.isSafeInteger(session.revision) || session.revision < 1 ||
      !["collecting", "ready_for_confirmation", "confirmed", "handed_off", "closed"].includes(session.status)) fail("invalid session envelope");
  validateSource({ ...session.source, allowedArticlePaths: [session.source?.articlePath] });
  if (!session.requirements || typeof session.requirements !== "object" || Array.isArray(session.requirements)) fail("invalid requirements");
  for (const [field, entry] of Object.entries(session.requirements)) {
    const value = validateValue(field, entry?.value);
    if (!["buyer-stated", "buyer-confirmed", "source-derived"].includes(entry?.provenance)) fail("invalid provenance");
    if (!text(entry?.updatedAt, 40) || !Number.isFinite(Date.parse(entry.updatedAt))) fail("invalid requirement timestamp");
    if (value !== entry.value) fail("non-normalized requirement");
  }
  if (!Array.isArray(session.turns) || session.turns.length > 200) fail("invalid turn history");
  return true;
}

export function applyRequirementPatch(sessionInput, patch, { now = new Date().toISOString(), expectedRevision } = {}) {
  assertSourcingSession(sessionInput);
  if (sessionInput.status !== "collecting" && sessionInput.status !== "ready_for_confirmation") fail("session is not editable");
  if (expectedRevision !== undefined && expectedRevision !== sessionInput.revision) fail("revision conflict");
  if (!patch || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) fail("empty patch");
  if (!Number.isFinite(Date.parse(now))) fail("invalid update timestamp");
  const next = clone(sessionInput);
  for (const [field, raw] of Object.entries(patch)) {
    const provenance = raw?.provenance ?? "buyer-stated";
    if (!["buyer-stated", "buyer-confirmed", "source-derived"].includes(provenance)) fail("invalid provenance");
    next.requirements[field] = {
      value: validateValue(field, raw?.value),
      provenance,
      updatedAt: now,
    };
  }
  next.status = getMissingRequiredFields(next).length === 0 ? "ready_for_confirmation" : "collecting";
  next.revision += 1;
  next.updatedAt = now;
  assertSourcingSession(next);
  return next;
}

export function getMissingRequiredFields(session) {
  assertSourcingSession(session);
  return Object.entries(SOURCING_FIELDS)
    .filter(([field, rule]) => rule.required && session.requirements[field]?.value == null)
    .map(([field, rule]) => ({ field, label: rule.label }));
}

export function getOptionalFollowUps(session) {
  assertSourcingSession(session);
  return Object.entries(SOURCING_FIELDS)
    .filter(([field, rule]) => !rule.required && session.requirements[field]?.value == null)
    .map(([field, rule]) => ({ field, label: rule.label }));
}

export function confirmSourcingSession(sessionInput, { expectedRevision, now = new Date().toISOString() } = {}) {
  assertSourcingSession(sessionInput);
  if (sessionInput.status !== "ready_for_confirmation") fail("required fields are incomplete");
  if (expectedRevision !== sessionInput.revision) fail("revision conflict");
  if (!Number.isFinite(Date.parse(now))) fail("invalid confirmation timestamp");
  const next = clone(sessionInput);
  for (const entry of Object.values(next.requirements)) {
    if (entry.provenance === "buyer-stated") entry.provenance = "buyer-confirmed";
  }
  next.status = "confirmed";
  next.confirmedAt = now;
  next.revision += 1;
  next.updatedAt = now;
  assertSourcingSession(next);
  return next;
}

export function markSourcingSessionHandedOff(sessionInput, { rfqId, expectedRevision, now = new Date().toISOString() }) {
  assertSourcingSession(sessionInput);
  if (sessionInput.status !== "confirmed") fail("buyer confirmation required before handoff");
  if (!ID.test(rfqId || "")) fail("invalid RFQ id");
  if (expectedRevision !== sessionInput.revision) fail("revision conflict");
  const next = clone(sessionInput);
  next.status = "handed_off";
  next.rfqId = rfqId;
  next.revision += 1;
  next.updatedAt = now;
  assertSourcingSession(next);
  return next;
}
