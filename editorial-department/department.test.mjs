import test from 'node:test';
import assert from 'node:assert/strict';
import manifest from './department.json' with { type: 'json' };
import { assertDepartmentManifest, authorizeSeatCapability, getCapability, getSeat } from './department.mjs';
import { assertMissionPlan, planIssueMission } from './mission.mjs';

const input = (overrides = {}) => ({
  tenantId: 'ent_chongker_demo',
  jobId: '11111111-1111-4111-8111-111111111111',
  sourceHash: 'a'.repeat(64),
  issueId: 'chongker-issue-001',
  selectedProductCount: 2,
  ...overrides,
});

test('department manifest declares seven on-demand seats and a bounded capability catalog', () => {
  const value = assertDepartmentManifest();
  assert.equal(value.seats.length, 7);
  assert.equal(value.runtime.bindingStatus, 'unbound');
  assert.equal(value.runtime.executionMode, 'plan-only');
  assert.ok(value.seats.every((seat) => seat.activation === 'on-demand' && seat.runtimeBinding === null));
  assert.equal(new Set(value.capabilities.map((capability) => capability.id)).size, value.capabilities.length);
  assert.equal(getSeat('art-director').title, 'Art & Photo Director');
  assert.equal(getCapability('editorial.draft-copy').status, 'planned');
});

test('all seven seats map exactly once into the six logical work areas', () => {
  const value=assertDepartmentManifest();
  const mapped=value.workspace.workAreas.flatMap((zone)=>zone.seatIds);
  assert.equal(mapped.length,7);
  assert.equal(new Set(mapped).size,7);
  const duplicate=structuredClone(manifest);
  duplicate.workspace.workAreas[1].seatIds.push('editor-in-chief');
  assert.throws(()=>assertDepartmentManifest(duplicate),/unknown or duplicated/);
});

test('manifest rejects duplicate seats, missing capability references and executable forbidden tools', () => {
  const duplicate = structuredClone(manifest);
  duplicate.seats.push(structuredClone(duplicate.seats[0]));
  assert.throws(() => assertDepartmentManifest(duplicate), /invalid seat contract/);

  const unknown = structuredClone(manifest);
  unknown.seats[0].capabilityIds.push('editorial.execute-shell');
  assert.throws(() => assertDepartmentManifest(unknown), /unknown or forbidden capability/);

  const forbidden = structuredClone(manifest);
  forbidden.capabilities.find((item) => item.id === 'supplier.contact').implementation = {
    kind: 'module-export', path: 'runtime/gateway.mjs', export: 'answerQuestion',
  };
  assert.throws(() => assertDepartmentManifest(forbidden), /planned, human-only and forbidden/);
});

test('seat authority is allowlisted, approval-gated and never inferred from role title', () => {
  assert.equal(authorizeSeatCapability('research-editor', 'source.capture-homepage').decision, 'approval-required');
  assert.equal(authorizeSeatCapability('research-editor', 'source.capture-homepage', ['websiteResearchAuthorized']).decision, 'allow');
  assert.equal(authorizeSeatCapability('art-director', 'media.materialize', ['mediaPolicyPassed']).decision, 'allow');
  assert.equal(authorizeSeatCapability('audience-editor', 'audience.read-feedback').decision, 'approval-required');
  assert.equal(authorizeSeatCapability('editorial-editor', 'media.materialize').reason, 'CAPABILITY_OUTSIDE_SEAT');
  assert.equal(authorizeSeatCapability('missing-seat', 'source.compile-enterprise').decision, 'deny');
  assert.equal(authorizeSeatCapability('audience-editor', 'supplier.contact').decision, 'deny');
});

test('mission plan is deterministic, tenant-bound and explicitly non-dispatchable', () => {
  const first = planIssueMission(input());
  const second = planIssueMission(input());
  assert.deepEqual(first, second);
  assert.match(first.id, /^mission-[a-f0-9]{24}$/);
  assert.equal(first.binding.tenantId, 'ent_chongker_demo');
  assert.equal(first.execution.dispatchable, false);
  assert.equal(first.execution.mode, 'plan-only');
  assert.equal(first.publication.state, 'blocked');
  assert.equal(first.tasks.find((task) => task.id === 'capture-source').readiness, 'approval-required');
  assert.equal(first.tasks.find((task) => task.id === 'compile-enterprise').readiness, 'dependency-blocked');
  assert.equal(first.tasks.find((task) => task.id === 'draft-editorial-copy').capabilityReadiness, 'not-implemented');
  assert.equal(first.tasks.find((task) => task.id === 'human-release-approval').capabilityReadiness, 'human-review');
  assert.ok(first.blockers.some((blocker) => blocker.taskId === 'draft-editorial-copy'));
  assertMissionPlan(first);
});

test('zero selected products produces an explicit no-gallery task, never product-story work', () => {
  const mission = planIssueMission(input({ selectedProductCount: 0 }));
  assert.ok(mission.tasks.some((task) => task.id === 'skip-product-gallery'));
  assert.ok(!mission.tasks.some((task) => task.id === 'draft-product-stories'));
  assert.equal(mission.binding.selectedProductCount, 0);
});

test('selected products create a bounded product-story task', () => {
  const mission = planIssueMission(input({ selectedProductCount: 12 }));
  assert.ok(mission.tasks.some((task) => task.id === 'draft-product-stories'));
  assert.ok(!mission.tasks.some((task) => task.id === 'skip-product-gallery'));
  assert.throws(() => planIssueMission(input({ selectedProductCount: 13 })), /invalid tenant\/job\/source\/issue binding/);
});

test('mission plan rejects changed tenant bindings and cyclic or altered task order', () => {
  const mission = planIssueMission(input());
  const wrongBinding = structuredClone(mission);
  wrongBinding.binding.sourceSha256 = 'b'.repeat(64);
  assert.throws(() => assertMissionPlan(wrongBinding), /immutable source binding/);

  const cycle = structuredClone(mission);
  cycle.tasks[0].dependsOn = ['build-private-preview'];
  assert.throws(() => assertMissionPlan(cycle), /cycle/);

  const order = structuredClone(mission);
  order.taskOrder.reverse();
  assert.throws(() => assertMissionPlan(order), /task order/);

  const blockers = structuredClone(mission);
  blockers.blockers = [];
  assert.throws(() => assertMissionPlan(blockers), /blocker summary/);
});

test('invalid tenant, job and source identities fail closed', () => {
  assert.throws(() => planIssueMission(input({ tenantId: '../other-tenant' })), /invalid tenant/);
  assert.throws(() => planIssueMission(input({ jobId: 'not-a-uuid' })), /invalid tenant/);
  assert.throws(() => planIssueMission(input({ sourceHash: 'not-a-hash' })), /invalid tenant/);
});
