import { assertDepartmentManifest } from './department.mjs';
import { planIssueMission } from './mission.mjs';
const department=assertDepartmentManifest();
const mission=planIssueMission({
  tenantId:'ent_contract_check',
  jobId:'11111111-1111-4111-8111-111111111111',
  sourceHash:'a'.repeat(64),
  issueId:'department-contract-check',
  selectedProductCount:1,
});
console.log(JSON.stringify({
  status:'CONTRACT_VALID',
  department:department.id,
  seats:department.seats.length,
  capabilities:department.capabilities.length,
  missionTasks:mission.tasks.length,
  execution:mission.execution.mode,
  dispatchable:mission.execution.dispatchable,
},null,2));
