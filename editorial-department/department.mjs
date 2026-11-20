import manifest from './department.json' with { type: 'json' };

const CAPABILITY_STATES = new Set(['implemented','implemented-gated','planned','human-only','forbidden']);
const SAFE_ID = /^[a-z][a-z0-9-]{1,79}$/;
const SAFE_CAPABILITY = /^[a-z][a-z0-9-]{1,79}(?:\.[a-z][a-z0-9-]{1,79})+$/;
const fail = (message) => { throw new TypeError('EDITORIAL_DEPARTMENT: ' + message); };
const safeRelativePath = (value) => typeof value === 'string' &&
  value.length <= 240 && !value.startsWith('/') && !value.includes('\\') &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');

export function assertDepartmentManifest(value = manifest) {
  if (!value || value.schemaVersion !== 'editorial-department/v1' ||
      !SAFE_ID.test(value.id || '') || value.operatingModel !== 'on-demand-seats' ||
      value.tenantBoundary !== 'one-enterprise-per-mission') fail('invalid department identity or operating model');
  if (!safeRelativePath(value.baseSkill) || value.runtime?.executionMode !== 'plan-only' ||
      value.runtime?.bindingStatus !== 'unbound' || value.runtime?.noSyntheticPresence !== true ||
      value.missionPolicy?.presenceRule !== 'derive-seat-presence-only-from-durable-task-state') {
    fail('runtime must remain unbound and presence must be event-derived');
  }
  if (!Array.isArray(value.seats) || value.seats.length < 5 || value.seats.length > 12 ||
      !Array.isArray(value.capabilities) || value.capabilities.length < 8) fail('seat/capability inventory is missing or unbounded');

  const capabilityById = new Map();
  for (const capability of value.capabilities) {
    if (!capability || !SAFE_CAPABILITY.test(capability.id || '') ||
        capabilityById.has(capability.id) || !CAPABILITY_STATES.has(capability.status) ||
        !Array.isArray(capability.requiredApprovals)) fail('invalid or duplicate capability');
    if (capability.status === 'implemented' || capability.status === 'implemented-gated') {
      const implementation = capability.implementation;
      if (!implementation || !['module-export','script'].includes(implementation.kind) ||
          !safeRelativePath(implementation.path) ||
          (implementation.kind === 'module-export' && !SAFE_ID.test(String(implementation.export || '').replaceAll('_','-')))) {
        fail('implemented capability requires a safe repository implementation reference');
      }
    } else if (capability.implementation !== null) {
      fail('planned, human-only and forbidden capabilities cannot expose an executable implementation');
    }
    capabilityById.set(capability.id, capability);
  }

  const seatById = new Map();
  for (const seat of value.seats) {
    if (!seat || !SAFE_ID.test(seat.id || '') || seatById.has(seat.id) ||
        !Array.isArray(seat.capabilityIds) || !Array.isArray(seat.responsibilities) ||
        !Array.isArray(seat.inputs) || !Array.isArray(seat.outputs) ||
        !safeRelativePath(seat.skillRef) || seat.activation !== 'on-demand' ||
        seat.runtimeBinding !== null) fail('invalid seat contract or runtime binding');
    for (const capabilityId of seat.capabilityIds) {
      const capability = capabilityById.get(capabilityId);
      if (!capability || capability.status === 'forbidden') fail('seat references an unknown or forbidden capability');
    }
    seatById.set(seat.id, seat);
  }

  const requiredDenied = ['contact-supplier','submit-buyer-enquiry','place-order','read-other-tenant-data','read-runtime-secrets','publish-without-human-approval'];
  if (value.securityPolicy?.noMockEvidence !== true ||
      value.securityPolicy?.noSyntheticPresence !== true ||
      !requiredDenied.every((action) => value.securityPolicy.forbiddenActions.includes(action))) {
    fail('mandatory safety boundaries are missing');
  }
  return value;
}

export function getSeat(seatId, value = manifest) {
  assertDepartmentManifest(value);
  return value.seats.find((seat) => seat.id === seatId) ?? null;
}

export function getCapability(capabilityId, value = manifest) {
  assertDepartmentManifest(value);
  return value.capabilities.find((capability) => capability.id === capabilityId) ?? null;
}

/**
 * Authorization describes whether a seat may request a capability.
 * It does not execute a tool, grant an approval, or bind a runtime.
 */
export function authorizeSeatCapability(seatId, capabilityId, approvals = [], value = manifest) {
  assertDepartmentManifest(value);
  const seat = value.seats.find((item) => item.id === seatId);
  const capability = value.capabilities.find((item) => item.id === capabilityId);
  if (!seat) return { decision: 'deny', reason: 'UNKNOWN_SEAT' };
  if (!capability) return { decision: 'deny', reason: 'UNKNOWN_CAPABILITY' };
  if (!seat.capabilityIds.includes(capabilityId)) return { decision: 'deny', reason: 'CAPABILITY_OUTSIDE_SEAT' };
  if (capability.status === 'forbidden') return { decision: 'deny', reason: 'FORBIDDEN_CAPABILITY' };
  if (capability.status === 'human-only') return { decision: 'human-required', reason: 'HUMAN_ONLY' };
  if (capability.status === 'planned') return { decision: 'blocked', reason: 'CAPABILITY_NOT_IMPLEMENTED' };
  const granted = new Set(Array.isArray(approvals) ? approvals : []);
  const missingApprovals = capability.requiredApprovals.filter((approval) => !granted.has(approval));
  if (missingApprovals.length) return { decision: 'approval-required', reason: 'MISSING_APPROVALS', missingApprovals };
  return { decision: 'allow', reason: 'CAPABILITY_AVAILABLE', implementation: capability.implementation };
}

assertDepartmentManifest();
export default manifest;