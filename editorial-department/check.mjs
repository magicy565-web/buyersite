import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import department from './department.json' with { type: 'json' };
import { assertDepartmentManifest } from './department.mjs';
import { planIssueMission } from './mission.mjs';

const checked = new Set();
async function verifyPath(path) {
  if (checked.has(path)) return;
  await access(resolve(path));
  checked.add(path);
}
async function verifyExport(capability) {
  const implementation=capability.implementation;
  if (implementation?.kind !== 'module-export') return;
  const source=await readFile(resolve(implementation.path),'utf8');
  const name=implementation.export.replaceAll('$','\\$').replaceAll('.','\\.');
  const pattern=new RegExp('export\\s+(?:async\\s+)?(?:function|const|class)\\s+'+name+'\\b');
  if(!pattern.test(source)) throw new Error('EDITORIAL_DEPARTMENT: missing export '+implementation.path+'#'+implementation.export);
}
assertDepartmentManifest(department);
await verifyPath(department.baseSkill);
await verifyPath(department.sharedProductionSkill);
for(const seat of department.seats) await verifyPath(seat.skillRef);
for(const capability of department.capabilities) {
  if(capability.implementation) {
    await verifyPath(capability.implementation.path);
    await verifyExport(capability);
  }
}
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
  zones:department.workspace.zones.length,
  capabilities:department.capabilities.length,
  checkedRepositoryReferences:checked.size,
  missionTasks:mission.tasks.length,
  missionBlockers:mission.blockers.length,
  execution:mission.execution.mode,
  dispatchable:mission.execution.dispatchable,
},null,2));
