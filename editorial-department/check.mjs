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
  const pattern=new RegExp('export\s+(?:async\s+)?(?:function|const|class)\s+'+name+'\\b');
  if(!pattern.test(source)) throw new Error('EDITORIAL_DEPARTMENT: missing export '+implementation.path+'#'+implementation.export);
}
assertDepartmentManifest(department);
await verifyPath(department.baseSkill);
await verifyPath(department.sharedProductionSkill);
await verifyPath(department.workspace.importablePackage);
for(const seat of department.seats) await verifyPath(seat.skillRef);
for(const capability of department.capabilities) {
  if(capability.implementation) {
    await verifyPath(capability.implementation.path);
    await verifyExport(capability);
  }
}

const packagePath=resolve(department.workspace.importablePackage);
const openMausPackage=JSON.parse(await readFile(packagePath,'utf8'));
const pkg=openMausPackage.package;
if(openMausPackage.format!=='openmaus.package' || openMausPackage.version!==2 ||
   pkg?.id!=='buyersite-editorial-department' || pkg?.team?.name!==department.workspace.sectionName ||
   pkg?.team?.leader!==department.workspace.chiefSeatId) {
  throw new Error('EDITORIAL_DEPARTMENT: OpenMausBot package identity/leader does not match department manifest');
}
if(!Array.isArray(pkg.agents) || pkg.agents.length!==department.seats.length ||
   pkg.connections!==undefined || pkg.routines!==undefined ||
   pkg.requirements?.apps?.length!==0 || pkg.requirements?.capabilities?.length!==0) {
  throw new Error('EDITORIAL_DEPARTMENT: package must contain only the seven role Bots and no app, connector or routine provisioning');
}
const packageAgents=new Map(pkg.agents.map(agent=>[agent.key,agent]));
const packageSkills=new Map((pkg.skills?.entries||[]).map(skill=>[skill.name,skill]));
const hiddenGroups=['meetings','data','pages','images','email'];
for(const seat of department.seats) {
  const agent=packageAgents.get(seat.id);
  const roleSkill=seat.skillRef.split('/').at(-1).replace(/\.md$/,'');
  if(!agent || !agent.skills.includes('editorial-department') ||
     !agent.skills.includes('buyersite-production') || !agent.skills.includes(roleSkill) ||
     !Array.isArray(agent.tools?.off) || hiddenGroups.some(group=>!agent.tools.off.includes(group))) {
    throw new Error('EDITORIAL_DEPARTMENT: OpenMausBot agent profile does not match seat '+seat.id);
  }
  for(const name of agent.skills) {
    const skill=packageSkills.get(name);
    if(!skill) throw new Error('EDITORIAL_DEPARTMENT: package is missing skill '+name);
    const frontmatter=skill.instructions.match(/^---\r?\nname:\s*([a-z0-9-]+)\r?\ndescription:\s*(.+)\r?\n---\r?\n/);
    if(!frontmatter || frontmatter[1]!==name || frontmatter[2]!==skill.description) {
      throw new Error('EDITORIAL_DEPARTMENT: portable Skill frontmatter does not match '+name);
    }
    const localPath=name==='editorial-department' ? 'skills/editorial-department/SKILL.md'
      : name==='buyersite-production' ? department.sharedProductionSkill : department.seats.find(item=>item.id===name)?.skillRef;
    if(!localPath || skill.instructions!==await readFile(resolve(localPath),'utf8')) {
      throw new Error('EDITORIAL_DEPARTMENT: packaged skill content drifted for '+name);
    }
  }
}
if(packageAgents.size!==department.seats.length || packageSkills.size!==9) {
  throw new Error('EDITORIAL_DEPARTMENT: package contains unexpected agents or skills');
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
  workAreas:department.workspace.workAreas.length,
  capabilities:department.capabilities.length,
  openMausPackage:department.workspace.importablePackage,
  packageAgents:packageAgents.size,
  packageSkills:packageSkills.size,
  checkedRepositoryReferences:checked.size,
  missionTasks:mission.tasks.length,
  missionBlockers:mission.blockers.length,
  execution:mission.execution.mode,
  dispatchable:mission.execution.dispatchable,
},null,2));
