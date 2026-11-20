import { createHash } from 'node:crypto';
import manifest from './department.json' with { type: 'json' };
import { assertDepartmentManifest, authorizeSeatCapability } from './department.mjs';

const SHA256 = /^[a-f0-9]{64}$/;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ISSUE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const fail = (message) => { throw new TypeError('EDITORIAL_MISSION: ' + message); };

function orderedTasks(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const indegree = new Map(tasks.map((task) => [task.id, task.dependsOn.length]));
  const followers = new Map(tasks.map((task) => [task.id, []]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency) || dependency === task.id) fail('task dependency is missing or self-referential');
      followers.get(dependency).push(task.id);
    }
  }
  const queue = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);
  const result = [];
  while (queue.length) {
    const id = queue.shift();
    result.push(id);
    for (const follower of followers.get(id)) {
      indegree.set(follower, indegree.get(follower) - 1);
      if (indegree.get(follower) === 0) queue.push(follower);
    }
  }
  if (result.length !== tasks.length) fail('mission graph contains a cycle');
  return result;
}

export function assertMissionPlan(mission, department = manifest) {
  assertDepartmentManifest(department);
  if (!mission || mission.schemaVersion !== 'editorial-mission/v1' ||
      mission.departmentId !== department.id || mission.missionType !== 'magazine-issue' ||
      mission.execution?.mode !== 'plan-only' || mission.execution?.dispatchable !== false ||
      !TENANT.test(mission.binding?.tenantId || '') || !UUID.test(mission.binding?.jobId || '') ||
      !SHA256.test(mission.binding?.sourceSha256 || '') || !ISSUE.test(mission.binding?.issueId || '')) {
    fail('invalid mission identity, immutable source binding or execution boundary');
  }
  if (!Array.isArray(mission.tasks) || mission.tasks.length < 8 || mission.tasks.length > 24) fail('mission task count is outside bounds');
  const ids = new Set();
  for (const task of mission.tasks) {
    if (!task || !ISSUE.test(task.id || '') || ids.has(task.id) ||
        !department.seats.some((seat) => seat.id === task.seatId) ||
        !Array.isArray(task.dependsOn) || !Array.isArray(task.requiredApprovals) ||
        task.state !== 'planned') fail('invalid or duplicate mission task');
    ids.add(task.id);
    if (task.capabilityId) {
      const decision = authorizeSeatCapability(task.seatId, task.capabilityId, task.requiredApprovals, department);
      if (!['allow','approval-required','blocked','human-required'].includes(decision.decision)) {
        fail('task requests a capability outside its seat authority');
      }
    } else if (!task.humanGate) {
      fail('task without a capability must declare a human gate');
    }
  }
  const taskOrder = orderedTasks(mission.tasks);
  if (!Array.isArray(mission.taskOrder) || JSON.stringify(taskOrder) !== JSON.stringify(mission.taskOrder)) {
    fail('task order does not match the dependency graph');
  }
  return mission;
}

/**
 * Build a deterministic, plan-only DAG. It is a contract for a future dispatcher,
 * not a claim that OpenMausBot seats are connected or that any task has run.
 */
export function planIssueMission({
  tenantId, jobId, sourceHash, issueId, selectedProductCount = 0, approvals = [],
} = {}, department = manifest) {
  assertDepartmentManifest(department);
  if (!TENANT.test(tenantId || '') || !UUID.test(jobId || '') ||
      !SHA256.test(sourceHash || '') || !ISSUE.test(issueId || '') ||
      !Number.isInteger(selectedProductCount) || selectedProductCount < 0 || selectedProductCount > 12 ||
      !Array.isArray(approvals)) fail('invalid tenant/job/source/issue binding or product count');

  const definitions = [
    {id:'capture-source',seatId:'research-editor',capabilityId:'source.capture-homepage',dependsOn:[],requiredApprovals:['websiteResearchAuthorized'],output:'captured-source-snapshot'},
    {id:'compile-enterprise',seatId:'research-editor',capabilityId:'source.compile-enterprise',dependsOn:['capture-source'],requiredApprovals:[],output:'enterprise-edition-pack'},
    {id:'editorial-outline',seatId:'editor-in-chief',capabilityId:'editorial.plan-outline',dependsOn:['compile-enterprise'],requiredApprovals:[],output:'source-bound-magazine-outline'},
    {id:'draft-editorial-copy',seatId:'editorial-editor',capabilityId:'editorial.draft-copy',dependsOn:['editorial-outline'],requiredApprovals:['editorialBriefApproved','evidenceBoundOutput'],output:'article-drafts'},
    {id:'art-direction',seatId:'art-director',capabilityId:'visual.plan',dependsOn:['editorial-outline'],requiredApprovals:[],output:'responsive-visual-plan'},
    {id:'prepare-media',seatId:'art-director',capabilityId:'media.materialize',dependsOn:['compile-enterprise','art-direction'],requiredApprovals:['mediaPolicyPassed'],output:'rights-bound-media-report'},
    {id:'compile-issue',seatId:'production-editor',capabilityId:'editorial.compile-issue',dependsOn:['draft-editorial-copy','prepare-media'],requiredApprovals:[],output:'validated-magazine-issue'},
    {id:'build-private-preview',seatId:'production-editor',capabilityId:'production.build-private',dependsOn:['compile-issue'],requiredApprovals:[],output:'private-astro-preview'},
    {id:'review-content',seatId:'standards-editor',capabilityId:'editorial.validate-issue',dependsOn:['compile-issue'],requiredApprovals:[],output:'content-contract-review'},
    {id:'review-media',seatId:'standards-editor',capabilityId:'media.review',dependsOn:['prepare-media'],requiredApprovals:['aiReviewAuthorized'],output:'media-review-receipts'},
    {id:'review-visuals',seatId:'standards-editor',capabilityId:'production.visual-review',dependsOn:['build-private-preview'],requiredApprovals:['aiReviewAuthorized'],output:'desktop-mobile-visual-review'},
    {id:'verify-output',seatId:'production-editor',capabilityId:'production.verify-output',dependsOn:['build-private-preview'],requiredApprovals:[],output:'output-integrity-report'},
    {id:'human-release-approval',seatId:'editor-in-chief',capabilityId:null,dependsOn:['review-content','review-media','review-visuals','verify-output'],requiredApprovals:['human-publication-approval'],humanGate:'human-publication-approval',output:'signed-publication-decision'},
    {id:'prepare-distribution',seatId:'audience-editor',capabilityId:'distribution.prepare',dependsOn:['human-release-approval'],requiredApprovals:['human-channel-approval'],output:'channel-distribution-plan'},
  ];
  if (selectedProductCount === 0) {
    // The issue outline must not invent a product gallery when no products were selected.
    definitions.splice(definitions.findIndex((task) => task.id === 'draft-editorial-copy') + 1, 0,
      {id:'skip-product-gallery',seatId:'editor-in-chief',capabilityId:'editorial.plan-outline',dependsOn:['editorial-outline'],requiredApprovals:[],output:'no-product-gallery-confirmation'});
  } else {
    definitions.splice(definitions.findIndex((task) => task.id === 'draft-editorial-copy') + 1, 0,
      {id:'draft-product-stories',seatId:'editorial-editor',capabilityId:'editorial.draft-copy',dependsOn:['editorial-outline'],requiredApprovals:['editorialBriefApproved','evidenceBoundOutput'],output:'selected-product-stories'});
  }

  const tasks = definitions.map((definition) => {
    const decision = definition.capabilityId
      ? authorizeSeatCapability(definition.seatId, definition.capabilityId, [...approvals, ...definition.requiredApprovals.filter((x) => x === 'human-publication-approval')], department)
      : {decision:'human-required',reason:'HUMAN_GATE'};
    const readiness = decision.decision === 'allow' ? 'ready'
      : decision.decision === 'approval-required' ? 'approval-required'
      : decision.decision === 'human-required' ? 'human-review'
      : decision.decision === 'blocked' ? 'not-implemented' : 'blocked';
    return {...definition,state:'planned',readiness,readinessReason:decision.reason};
  });
  const taskOrder = orderedTasks(tasks);
  const missionId = 'mission-' + createHash('sha256')
    .update(JSON.stringify({tenantId,jobId,sourceHash,issueId,selectedProductCount}))
    .digest('hex').slice(0,24);
  const mission = {
    schemaVersion:'editorial-mission/v1',
    id:missionId,
    departmentId:department.id,
    missionType:'magazine-issue',
    state:'planned',
    binding:{tenantId,jobId,sourceSha256:sourceHash,issueId,selectedProductCount},
    execution:{mode:'plan-only',dispatchable:false,reason:'OpenMausBot seat bindings and the mission dispatcher are not connected by this foundation.'},
    tasks,
    taskOrder,
    publication:{state:'blocked',approvalRequired:'human-publication-approval',externalDistribution:'not-configured'},
    createdBy:'editorial-department-foundation',
  };
  return assertMissionPlan(mission,department);
}

export { orderedTasks };