import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorialMissionRuntime } from './runtime.mjs';
import { planIssueMission } from './mission.mjs';

const fixture=()=>{
  const source=Buffer.from(JSON.stringify({
    enterprise:{id:'ent_runtime_test',company:{revision:7,displayName:'Runtime Test Supplier',description:'Source-bound test fixture'}},
    products:[],
    collectionAuthorized:true,
    website:'https://example.com/',
  }));
  const job={
    id:randomUUID(),
    enterpriseId:'ent_runtime_test',
    outputKind:'site',
    sourceHash:createHash('sha256').update(source).digest('hex'),
    input:{allowResearch:true,productIds:[],url:'https://example.com/'},
  };
  const plan=planIssueMission({
    tenantId:job.enterpriseId,
    jobId:job.id,
    sourceHash:job.sourceHash,
    issueId:'runtime-test-issue',
    selectedProductCount:0,
  });
  return {source,job,plan};
};

async function withRuntime(run){
  const root=await mkdtemp(join(tmpdir(),'buyersite-editorial-runtime-'));
  try{
    const runtime=await new EditorialMissionRuntime({dataDir:root}).init();
    await run(runtime,root);
  }finally{
    await rm(root,{recursive:true,force:true});
  }
}

test('creates a durable mission bound to one tenant, job and exact source bytes',async()=>{
  await withRuntime(async(runtime,root)=>{
    const f=fixture();
    const mission=await runtime.createMission({
      plan:f.plan,job:f.job,sourceBytes:f.source,
      approvals:['websiteResearchAuthorized'],
    });
    assert.equal(mission.id,f.plan.id);
    assert.equal(mission.binding.tenantId,f.job.enterpriseId);
    assert.equal(mission.binding.sourceSha256,f.job.sourceHash);
    assert.equal(mission.state,'active');
    assert.equal(mission.tasks.find(task=>task.id==='capture-source').state,'queued');
    assert.equal(mission.tasks.find(task=>task.id==='compile-enterprise').state,'blocked');
    assert.equal(mission.publication.state,'blocked');
    assert.equal(mission.publication.publicReleaseSupported,false);
    assert.deepEqual(await runtime.readSourceBytes(mission.id),f.source);

    const restored=await new EditorialMissionRuntime({dataDir:root}).init();
    assert.deepEqual(restored.getPublicMission(mission.id),mission);
  });
});

test('rejects a source snapshot whose bytes do not match the immutable mission hash',async()=>{
  await withRuntime(async(runtime)=>{
    const f=fixture();
    await assert.rejects(
      runtime.createMission({plan:f.plan,job:f.job,sourceBytes:Buffer.concat([f.source,Buffer.from('tamper')])}),
      error=>error.code==='MISSION_SOURCE_BINDING_MISMATCH',
    );
  });
});

test('task access is seat-scoped, short-lived and survives persistence without exposing the token',async()=>{
  await withRuntime(async(runtime,root)=>{
    const f=fixture();
    const mission=await runtime.createMission({
      plan:f.plan,job:f.job,sourceBytes:f.source,
      approvals:['websiteResearchAuthorized'],
    });
    const taskId='capture-source';
    const seatId='research-editor';
    const accessToken=Buffer.from('a'.repeat(48)).toString('base64url');
    const sendId=randomUUID();
    runtime.bindTaskAccessToken({missionId:mission.id,taskId,seatId,accessToken});
    await runtime.recordDispatchTarget({
      missionId:mission.id,taskId,seatId,botId:'research-bot',threadId:'research-thread',sendId,
    });
    await runtime.recordDispatchSent({missionId:mission.id,taskId,seatId,threadId:'research-thread'});

    const restored=await new EditorialMissionRuntime({dataDir:root}).init();
    const context=await restored.getTaskContext(mission.id,taskId,seatId,accessToken);
    assert.equal(context.binding.sourceSha256,f.job.sourceHash);
    assert.equal(context.task.id,taskId);
    assert.equal(context.enterprise.website,'https://example.com/');
    assert.equal(JSON.stringify(restored.getPublicMission(mission.id)).includes(accessToken),false);

    await assert.rejects(
      restored.getTaskContext(mission.id,taskId,'editorial-editor',accessToken),
      error=>error.code==='MISSION_ACCESS_DENIED',
    );
    await assert.rejects(
      restored.getTaskContext(mission.id,taskId,seatId,'wrong-token'),
      error=>error.code==='MISSION_ACCESS_DENIED',
    );
  });
});

test('dispatch target cannot be rebound to a different Bot or thread',async()=>{
  await withRuntime(async(runtime)=>{
    const f=fixture();
    const mission=await runtime.createMission({
      plan:f.plan,job:f.job,sourceBytes:f.source,
      approvals:['websiteResearchAuthorized'],
    });
    const input={missionId:mission.id,taskId:'capture-source',seatId:'research-editor',botId:'research-bot',threadId:'research-thread',sendId:randomUUID()};
    await runtime.recordDispatchTarget(input);
    await assert.rejects(
      runtime.recordDispatchTarget({...input,botId:'other-bot'}),
      error=>error.code==='MISSION_DISPATCH_CONFLICT',
    );
  });
});

test('a public release can never be enabled by approving the private preview',async()=>{
  await withRuntime(async(runtime)=>{
    const f=fixture();
    const mission=await runtime.createMission({
      plan:f.plan,job:f.job,sourceBytes:f.source,
      approvals:['websiteResearchAuthorized'],
    });
    const state=runtime.getPublicMission(mission.id).publication;
    assert.equal(state.state,'blocked');
    assert.equal(state.publicReleaseSupported,false);
  });
});


test('stdio MCP tool schemas require and forward the per-task access token',async()=>{
  const source=await readFile(new URL('./mcp-server.mjs',import.meta.url),'utf8');
  for(const name of ['buyersite_mission_get','buyersite_task_claim','buyersite_task_complete','buyersite_task_fail','buyersite_artifact_get']){
    const start=source.indexOf("{name:'"+name+"'");
    assert.notEqual(start,-1,'missing tool '+name);
    const nextTool=source.indexOf('\n  {name:',start+1);
    const end=nextTool===-1?source.indexOf('\n];',start):nextTool;
    const definition=source.slice(start,end);
    assert.match(definition,/taskAccessToken/,'tool schema must require task token: '+name);
  }
  assert.match(source,/runtime\.getTaskContext\(args\.missionId,args\.taskId,seatId,args\.taskAccessToken\)/);
  assert.match(source,/runtime\.claimTask\(\{missionId:args\.missionId,taskId:args\.taskId,seatId,accessToken:args\.taskAccessToken\}\)/);
  assert.match(source,/runtime\.completeTask\(\{missionId:args\.missionId,taskId:args\.taskId,seatId,accessToken:args\.taskAccessToken/);
  assert.match(source,/runtime\.failTask\(\{missionId:args\.missionId,taskId:args\.taskId,seatId,accessToken:args\.taskAccessToken/);
  assert.match(source,/runtime\.getArtifact\(args\.missionId,args\.artifactTaskId,seatId,args\.currentTaskId,args\.taskAccessToken\)/);
});
