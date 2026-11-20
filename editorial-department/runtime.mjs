import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import manifest from './department.json' with { type: 'json' };
import { assertMissionPlan } from './mission.mjs';
import { validateTaskArtifact } from './artifact-contract.mjs';
import { getCapability } from './department.mjs';

const MISSION_ID=/^mission-[a-f0-9]{24}$/;
const TASK_ID=/^[a-z][a-z0-9-]{1,63}$/;
const SHA=/^[a-f0-9]{64}$/;
const LEASE_MS=60*60_000;
const ACCESS_MS=4*60*60_000;
const MAX_ATTEMPTS=2;
const fail=(code,status=409)=>{const error=new Error(code);error.code=code;error.status=status;throw error;};
const hash=value=>createHash('sha256').update(value).digest('hex');
const jsonHash=value=>hash(JSON.stringify(value));
const sameSecret=(given,expected)=>{
  const a=Buffer.from(String(given||'')),b=Buffer.from(String(expected||''));
  return a.length===b.length&&timingSafeEqual(a,b);
};
const atomicJson=async(path,value)=>{
  const temporary=path+'.'+process.pid+'.'+randomBytes(6).toString('hex')+'.tmp';
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  await chmod(temporary,0o600);
  await rename(temporary,path);
};
const parseJson=async path=>{
  try{return JSON.parse(await readFile(path,'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
};
const clone=value=>structuredClone(value);
const isObject=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);

function dependencyClosure(plan,taskId){
  const byId=new Map(plan.tasks.map(task=>[task.id,task]));
  const found=new Set();
  const visit=id=>{
    const task=byId.get(id);
    if(!task)fail('MISSION_TASK_UNKNOWN',404);
    for(const dependency of task.dependsOn){
      if(found.has(dependency))continue;
      found.add(dependency);
      visit(dependency);
    }
  };
  visit(taskId);
  return found;
}

function publicMission(record){
  return {
    schemaVersion:record.schemaVersion,
    id:record.id,
    state:record.state,
    binding:clone(record.plan.binding),
    sourceBinding:clone(record.sourceBinding),
    approvals:[...record.approvals].sort(),
    tasks:record.plan.tasks.map(task=>{
      const state=record.tasks[task.id];
      return {
        id:task.id,seatId:task.seatId,dependsOn:task.dependsOn,
        output:task.output,humanGate:task.humanGate||null,
        state:state.state,attempts:state.attempts,
        artifactSha256:state.artifactSha256||null,
        dispatch:state.dispatch?{botId:state.dispatch.botId,threadId:state.dispatch.threadId,state:state.dispatch.state}:null,
        error:state.error||null,reason:state.reason||null,
        updatedAt:state.updatedAt,
      };
    }),
    publication:clone(record.publication),
    createdAt:record.createdAt,
    updatedAt:record.updatedAt,
  };
}

export class EditorialMissionRuntime {
  constructor({dataDir,clock=()=>Date.now(),onChange=()=>{}}={}){
    if(typeof dataDir!=='string'||!dataDir)fail('MISSION_DATA_DIR_REQUIRED',500);
    this.root=resolve(dataDir);
    this.clock=clock;
    this.onChange=onChange;
    this.records=new Map();
    this.tail=Promise.resolve();
  }

  async init(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    await chmod(this.root,0o700);
    for(const entry of await readdir(this.root,{withFileTypes:true})){
      if(!entry.isDirectory()||!MISSION_ID.test(entry.name))continue;
      const path=join(this.root,entry.name,'mission.json');
      const record=await parseJson(path);
      if(!record)continue;
      this.assertRecord(record);
      this.records.set(record.id,record);
    }
    return this;
  }

  exclusive(work){
    const next=this.tail.then(work,work);
    this.tail=next.then(()=>undefined,()=>undefined);
    return next;
  }

  missionDir(missionId){
    if(!MISSION_ID.test(missionId||''))fail('MISSION_ID_INVALID',400);
    return join(this.root,missionId);
  }

  async save(record){
    record.updatedAt=this.clock();
    await atomicJson(join(this.missionDir(record.id),'mission.json'),record);
    this.onChange({kind:'mission',missionId:record.id});
  }

  assertRecord(record){
    if(!isObject(record)||record.schemaVersion!=='editorial-runtime/v1'||
       !MISSION_ID.test(record.id||'')||record.id!==record.plan?.id||
       record.plan?.departmentId!==manifest.id||
       !isObject(record.job)||record.job.id!==record.plan.binding.jobId||
       record.job.enterpriseId!==record.plan.binding.tenantId||
       record.job.sourceHash!==record.plan.binding.sourceSha256||
       !isObject(record.tasks)||!Array.isArray(record.approvals)||
       !isObject(record.publication))fail('MISSION_RECORD_INVALID',500);
    assertMissionPlan(record.plan);
    for(const task of record.plan.tasks){
      const state=record.tasks[task.id];
      if(!isObject(state)||!['blocked','queued','running','completed','failed'].includes(state.state)||
         !Number.isInteger(state.attempts)||state.attempts<0||state.attempts>MAX_ATTEMPTS)fail('MISSION_TASK_STATE_INVALID',500);
      if(state.artifactSha256!==undefined&&!SHA.test(state.artifactSha256))fail('MISSION_ARTIFACT_HASH_INVALID',500);
      if(state.artifactPath!==undefined&&!/^artifacts\/[a-z][a-z0-9-]{1,63}\.json$/.test(state.artifactPath))fail('MISSION_ARTIFACT_PATH_INVALID',500);
    }
    return record;
  }

  async createMission({plan,job,sourceBytes,approvals=[],sourceBinding}={}){
    return this.exclusive(async()=>{
      assertMissionPlan(plan);
      if(!isObject(job)||job.id!==plan.binding.jobId||job.enterpriseId!==plan.binding.tenantId||
         job.sourceHash!==plan.binding.sourceSha256||!Buffer.isBuffer(sourceBytes)||
         hash(sourceBytes)!==plan.binding.sourceSha256)fail('MISSION_SOURCE_BINDING_MISMATCH',409);
      if(!Array.isArray(approvals)||approvals.some(item=>typeof item!=='string'||item.length>100))fail('MISSION_APPROVALS_INVALID',400);
      const existing=this.records.get(plan.id);
      if(existing){
        if(existing.job.enterpriseId!==job.enterpriseId||existing.job.sourceHash!==job.sourceHash)fail('MISSION_ID_CONFLICT',409);
        return publicMission(existing);
      }
      const missionDir=this.missionDir(plan.id);
      await mkdir(missionDir,{recursive:false,mode:0o700});
      await mkdir(join(missionDir,'artifacts'),{recursive:true,mode:0o700});
      await writeFile(join(missionDir,'source.json'),sourceBytes,{mode:0o600,flag:'wx'});
      const now=this.clock();
      const record={
        schemaVersion:'editorial-runtime/v1',
        id:plan.id,
        state:'active',
        plan:clone(plan),
        job:clone(job),
        sourceBinding:clone(sourceBinding||{
          jobId:job.id,enterpriseId:job.enterpriseId,sourceSha256:job.sourceHash,
        }),
        approvals:[...new Set(approvals)],
        tasks:Object.fromEntries(plan.tasks.map(task=>[task.id,{
          state:'blocked',attempts:0,createdAt:now,updatedAt:now,
        }])),
        publication:{state:'blocked',approvalRequired:'human-publication-approval',publicReleaseSupported:false},
        createdAt:now,updatedAt:now,
      };
      this.refreshReady(record);
      this.assertRecord(record);
      this.records.set(record.id,record);
      await this.save(record);
      return publicMission(record);
    });
  }

  refreshReady(record){
    const byId=new Map(record.plan.tasks.map(task=>[task.id,task]));
    let changed=true;
    while(changed){
      changed=false;
      for(const taskId of record.plan.taskOrder){
        const task=byId.get(taskId),state=record.tasks[taskId];
        if(!['blocked','queued'].includes(state.state)||task.humanGate)continue;
        const capability=task.capabilityId?getCapability(task.capabilityId):null;
        if(!capability||['planned','forbidden','human-only'].includes(capability.status)){
          if(state.state!=='blocked'||state.reason!=='CAPABILITY_UNAVAILABLE'){
            state.state='blocked';state.reason='CAPABILITY_UNAVAILABLE';state.updatedAt=this.clock();changed=true;
          }
          continue;
        }
        const required=[...new Set([...task.requiredApprovals,...capability.requiredApprovals])];
        if(required.some(approval=>!record.approvals.includes(approval))){
          if(state.state!=='blocked'||state.reason!=='APPROVAL_REQUIRED'){
            state.state='blocked';state.reason='APPROVAL_REQUIRED';state.updatedAt=this.clock();changed=true;
          }
          continue;
        }
        if(task.dependsOn.some(id=>record.tasks[id]?.state!=='completed')){
          if(state.state!=='blocked'||state.reason!=='DEPENDENCIES_PENDING'){
            state.state='blocked';state.reason='DEPENDENCIES_PENDING';state.updatedAt=this.clock();changed=true;
          }
          continue;
        }
        if(state.state!=='queued'){
          state.state='queued';delete state.reason;state.updatedAt=this.clock();changed=true;
        }
      }
    }
    const all=record.plan.tasks.map(task=>record.tasks[task.id].state);
    if(all.every(state=>state==='completed'))record.state='completed';
    else if(all.some(state=>state==='failed'))record.state='attention';
    else record.state='active';
  }

  getMission(missionId){
    const record=this.records.get(missionId);
    if(!record)fail('MISSION_NOT_FOUND',404);
    return publicMission(record);
  }

  getQueuedTasks(missionId){
    const record=this.records.get(missionId);
    if(!record)fail('MISSION_NOT_FOUND',404);
    return record.plan.taskOrder.flatMap(taskId=>{
      const task=record.plan.tasks.find(item=>item.id===taskId);
      const state=record.tasks[taskId];
      return state.state==='queued'&&state.dispatch?.state!=='sent'
        ? [{task:clone(task),state:clone({attempts:state.attempts,dispatch:state.dispatch||null})}]
        : [];
    });
  }

  async recordDispatchTarget({missionId,taskId,seatId,botId,threadId,sendId}={}){
    return this.exclusive(async()=>{
      const record=this.records.get(missionId);
      if(!record)fail('MISSION_NOT_FOUND',404);
      const task=record.plan.tasks.find(item=>item.id===taskId);
      if(!task||task.seatId!==seatId)fail('SEAT_TASK_SCOPE_DENIED',403);
      const state=record.tasks[taskId];
      if(state.state!=='queued')fail('MISSION_TASK_NOT_QUEUED',409);
      if(!/^[A-Za-z0-9_-]{1,128}$/.test(botId||'')||! /^[A-Za-z0-9_-]{1,128}$/.test(threadId||'')||
         !/^[a-f0-9-]{36}$/i.test(sendId||''))fail('MISSION_DISPATCH_BINDING_INVALID',400);
      if(state.dispatch&&(state.dispatch.threadId!==threadId||state.dispatch.botId!==botId))fail('MISSION_DISPATCH_CONFLICT',409);
      state.dispatch={seatId,botId,threadId,sendId,state:'created',createdAt:state.dispatch?.createdAt||this.clock()};
      state.updatedAt=this.clock();
      await this.save(record);
      return publicMission(record);
    });
  }

  async recordDispatchSent({missionId,taskId,seatId,threadId}={}){
    return this.exclusive(async()=>{
      const record=this.records.get(missionId);
      if(!record)fail('MISSION_NOT_FOUND',404);
      const task=record.plan.tasks.find(item=>item.id===taskId);
      const state=record.tasks[taskId];
      if(!task||task.seatId!==seatId||state.state!=='queued'||
         state.dispatch?.threadId!==threadId)fail('MISSION_DISPATCH_CONFLICT',409);
      state.dispatch.state='sent';
      state.dispatch.sentAt=this.clock();
      state.updatedAt=this.clock();
      delete state.dispatchError;
      await this.save(record);
      return publicMission(record);
    });
  }

  async recordDispatchError({missionId,taskId,seatId,code}={}){
    return this.exclusive(async()=>{
      const record=this.records.get(missionId);
      if(!record)fail('MISSION_NOT_FOUND',404);
      const task=record.plan.tasks.find(item=>item.id===taskId);
      const state=record.tasks[taskId];
      if(!task||task.seatId!==seatId||state.state!=='queued')fail('MISSION_DISPATCH_CONFLICT',409);
      state.dispatchError=String(code||'DISPATCH_FAILED').slice(0,100);
      state.updatedAt=this.clock();
      await this.save(record);
      return publicMission(record);
    });
  }

  getJob(missionId){
    const record=this.records.get(missionId);
    if(!record)fail('MISSION_NOT_FOUND',404);
    return clone(record.job);
  }

  async readSourceBytes(missionId){
    const record=this.records.get(missionId);
    if(!record)fail('MISSION_NOT_FOUND',404);
    return readFile(join(this.missionDir(missionId),'source.json'));
  }

  bindTaskAccessToken({missionId,taskId,seatId,accessToken}={}){
    const record=this.records.get(missionId);
    if(!record)fail('MISSION_NOT_FOUND',404);
    const task=record.plan.tasks.find(item=>item.id===taskId);
    const state=record.tasks[taskId];
    if(!task||task.seatId!==seatId||state.state!=='queued' || typeof accessToken!=='string' || accessToken.length<32)fail('MISSION_ACCESS_BINDING_DENIED',403);
    state.accessHash=hash(accessToken);
    state.accessExpiresAt=this.clock()+ACCESS_MS;
    state.updatedAt=this.clock();
    return true;
  }

  assertTaskAccess({missionId,taskId,seatId,accessToken}={}){
    const record=this.records.get(missionId);
    if(!record)fail('MISSION_NOT_FOUND',404);
    const task=record.plan.tasks.find(item=>item.id===taskId);
    const state=record.tasks[taskId];
    if(!task||task.seatId!==seatId||!state?.accessHash||state.accessExpiresAt<=this.clock() ||
       typeof accessToken!=='string'||!sameSecret(hash(accessToken),state.accessHash))fail('MISSION_ACCESS_DENIED',403);
    return true;
  }

  async getTaskContext(missionId,taskId,seatId,accessToken){
    this.assertTaskAccess({missionId,taskId,seatId,accessToken});
    const record=this.records.get(missionId);
    if(!record)fail('MISSION_NOT_FOUND',404);
    const task=record.plan.tasks.find(item=>item.id===taskId);
    if(!task)fail('MISSION_TASK_NOT_FOUND',404);
    if(task.seatId!==seatId&&seatId!=='editor-in-chief'&&seatId!=='standards-editor')fail('SEAT_TASK_SCOPE_DENIED',403);
    const sourceBytes=await this.readSourceBytes(missionId);
    const snapshot=JSON.parse(sourceBytes.toString('utf8'));
    const company=snapshot.enterprise?.company||{};
    const selected=new Set(record.job.input?.productIds||[]);
    const products=(snapshot.products||[]).filter(product=>selected.has(product.id)).map(({id,name,category,description,revision})=>({id,name,category,description,revision}));
    const ancestors=dependencyClosure(record.plan,taskId);
    const artifacts={};
    for(const dependencyId of ancestors){
      const state=record.tasks[dependencyId];
      if(state?.state!=='completed'||!state.artifactPath)continue;
      const bytes=await readFile(join(this.missionDir(missionId),state.artifactPath));
      if(hash(bytes)!==state.artifactSha256)fail('MISSION_ARTIFACT_CHANGED',503);
      artifacts[dependencyId]=JSON.parse(bytes.toString('utf8'));
    }
    const context={
      missionId,
      task:clone(task),
      taskState:{state:record.tasks[taskId].state,attempts:record.tasks[taskId].attempts,
        reason:record.tasks[taskId].reason||null,error:record.tasks[taskId].error||null,
        artifactSha256:record.tasks[taskId].artifactSha256||null,updatedAt:record.tasks[taskId].updatedAt},
      binding:clone(record.plan.binding),
      approvals:[...record.approvals],
      enterprise:{
        id:record.job.enterpriseId,
        displayName:company.displayName||'',
        legalName:company.legalName||'',
        description:company.description||'',
        website:record.job.input?.url||snapshot.website||'',
        companyRevision:company.revision,
        products,
      },
      artifacts,
    };
    if(seatId==='research-editor'){
      context.researchAuthorization={
        websiteCaptureAuthorized:record.approvals.includes('websiteResearchAuthorized'),
        websiteUrl:record.job.input?.url||null,
      };
    }
    return context;
  }

  async getArtifact(missionId,artifactTaskId,seatId,currentTaskId,accessToken){
    this.assertTaskAccess({missionId,taskId:currentTaskId,seatId,accessToken});
    const record=this.records.get(missionId);
    if(!record)fail('MISSION_NOT_FOUND',404);
    const state=record.tasks[artifactTaskId];
    if(!state||state.state!=='completed'||!state.artifactPath)fail('MISSION_ARTIFACT_NOT_READY',409);
    const allowed=seatId==='editor-in-chief'||seatId==='standards-editor'||
      (currentTaskId&&dependencyClosure(record.plan,currentTaskId).has(artifactTaskId))||
      record.plan.tasks.find(task=>task.id===artifactTaskId)?.seatId===seatId;
    if(!allowed)fail('SEAT_ARTIFACT_SCOPE_DENIED',403);
    const bytes=await readFile(join(this.missionDir(missionId),state.artifactPath));
    if(hash(bytes)!==state.artifactSha256)fail('MISSION_ARTIFACT_CHANGED',503);
    return JSON.parse(bytes.toString('utf8'));
  }

  async claimTask({missionId,taskId,seatId,accessToken}={}){
    return this.exclusive(async()=>{
      this.assertTaskAccess({missionId,taskId,seatId,accessToken});
      const record=this.records.get(missionId);
      if(!record)fail('MISSION_NOT_FOUND',404);
      const task=record.plan.tasks.find(item=>item.id===taskId);
      if(!task)fail('MISSION_TASK_NOT_FOUND',404);
      if(task.seatId!==seatId)fail('SEAT_TASK_SCOPE_DENIED',403);
      const state=record.tasks[taskId];
      const now=this.clock();
      if(state.state==='running'&&state.leaseExpiresAt<=now){
        state.state='queued';delete state.leaseHash;delete state.leaseExpiresAt;
      }
      if(state.state!=='queued')fail(state.state==='running'?'MISSION_TASK_ALREADY_CLAIMED':'MISSION_TASK_NOT_READY',409);
      if(!state.dispatch||!['created','sent'].includes(state.dispatch.state))fail('MISSION_TASK_NOT_DISPATCHED',409);
      if(state.attempts>=MAX_ATTEMPTS)fail('MISSION_TASK_RETRY_LIMIT',409);
      const capability=task.capabilityId?getCapability(task.capabilityId):null;
      if(task.humanGate||!capability||['planned','forbidden','human-only'].includes(capability.status))fail('MISSION_TASK_NOT_EXECUTABLE',409);
      const required=[...new Set([...task.requiredApprovals,...capability.requiredApprovals])];
      if(required.some(approval=>!record.approvals.includes(approval))||
         task.dependsOn.some(id=>record.tasks[id]?.state!=='completed'))fail('MISSION_TASK_GATES_UNMET',409);
      const claimToken=randomBytes(32).toString('base64url');
      state.state='running';
      state.attempts+=1;
      state.leaseHash=hash(claimToken);
      state.leaseExpiresAt=now+LEASE_MS;
      state.claimedBySeat=seatId;
      state.updatedAt=now;
      await this.save(record);
      return {missionId,taskId,seatId,claimToken,leaseExpiresAt:state.leaseExpiresAt,attempt:state.attempts};
    });
  }

  async completeTask({missionId,taskId,seatId,claimToken,accessToken,artifact}={}){
    return this.exclusive(async()=>{
      this.assertTaskAccess({missionId,taskId,seatId,accessToken});
      const record=this.records.get(missionId);
      if(!record)fail('MISSION_NOT_FOUND',404);
      const task=record.plan.tasks.find(item=>item.id===taskId);
      if(!task)fail('MISSION_TASK_NOT_FOUND',404);
      if(task.seatId!==seatId)fail('SEAT_TASK_SCOPE_DENIED',403);
      const state=record.tasks[taskId];
      if(state.state==='completed'){
        const existingBytes=await readFile(join(this.missionDir(missionId),state.artifactPath));
        const existingArtifact=JSON.parse(existingBytes.toString('utf8'));
        if(jsonHash(existingArtifact)===jsonHash(artifact))return publicMission(record);
        fail('MISSION_TASK_ALREADY_COMPLETED',409);
      }
      if(state.state!=='running'||state.leaseExpiresAt<=this.clock()||
         !sameSecret(hash(claimToken),state.leaseHash))fail('MISSION_TASK_LEASE_INVALID',409);
      const compiledState=record.tasks['compile-enterprise'];
      let compiled=null;
      if(compiledState?.state==='completed'&&compiledState.artifactPath){
        const bytes=await readFile(join(this.missionDir(missionId),compiledState.artifactPath));
        if(hash(bytes)!==compiledState.artifactSha256)fail('MISSION_ARTIFACT_CHANGED',503);
        compiled=JSON.parse(bytes.toString('utf8')).compiled;
      }
      const websiteUrl=record.job.input?.url;
      const valid=validateTaskArtifact(taskId,artifact,{compiled,websiteUrl});
      const bytes=Buffer.from(JSON.stringify(valid,null,2)+'\n');
      const digest=hash(bytes);
      const artifactPath='artifacts/'+taskId+'.json';
      await writeFile(join(this.missionDir(missionId),artifactPath),bytes,{mode:0o600,flag:'w'});
      state.state='completed';
      state.artifactPath=artifactPath;
      state.artifactSha256=digest;
      state.completedAt=this.clock();
      state.updatedAt=state.completedAt;
      delete state.leaseHash;delete state.leaseExpiresAt;delete state.claimedBySeat;
      delete state.accessHash;delete state.accessExpiresAt;
      delete state.error;delete state.reason;
      this.refreshReady(record);
      this.assertRecord(record);
      await this.save(record);
      return publicMission(record);
    });
  }

  async failTask({missionId,taskId,seatId,claimToken,accessToken,code='TASK_FAILED',message='Task failed'}={}){
    return this.exclusive(async()=>{
      this.assertTaskAccess({missionId,taskId,seatId,accessToken});
      const record=this.records.get(missionId);
      if(!record)fail('MISSION_NOT_FOUND',404);
      const task=record.plan.tasks.find(item=>item.id===taskId);
      if(!task)fail('MISSION_TASK_NOT_FOUND',404);
      if(task.seatId!==seatId)fail('SEAT_TASK_SCOPE_DENIED',403);
      const state=record.tasks[taskId];
      if(state.state!=='running'||state.leaseExpiresAt<=this.clock()||
         !sameSecret(hash(claimToken),state.leaseHash))fail('MISSION_TASK_LEASE_INVALID',409);
      state.state='failed';
      state.error={code:String(code).slice(0,80),message:String(message).slice(0,500)};
      state.updatedAt=this.clock();
      delete state.leaseHash;delete state.leaseExpiresAt;delete state.claimedBySeat;
      delete state.accessHash;delete state.accessExpiresAt;
      this.refreshReady(record);
      await this.save(record);
      return publicMission(record);
    });
  }

  async approveHumanTask({missionId,taskId,approvedBy,approvedArtifactSha256}={}){
    return this.exclusive(async()=>{
      const record=this.records.get(missionId);
      if(!record)fail('MISSION_NOT_FOUND',404);
      const task=record.plan.tasks.find(item=>item.id===taskId);
      if(!task?.humanGate)fail('MISSION_HUMAN_GATE_REQUIRED',409);
      if(typeof approvedBy!=='string'||!approvedBy.trim()||approvedBy.length>120)fail('HUMAN_APPROVER_REQUIRED',400);
      const requiredArtifactTask=taskId==='human-brief-approval'?'editorial-outline':
        taskId==='human-release-approval'?'build-private-preview':null;
      if(!requiredArtifactTask)fail('MISSION_HUMAN_GATE_UNKNOWN',409);
      const requiredState=record.tasks[requiredArtifactTask];
      if(requiredState?.state!=='completed'||requiredState.artifactSha256!==approvedArtifactSha256)fail('HUMAN_APPROVAL_STALE',409);
      if(taskId==='human-release-approval'){
        const gates=['review-content','review-media','review-visuals','verify-output'];
        for(const gate of gates){
          const state=record.tasks[gate];
          if(state?.state!=='completed')fail('PUBLICATION_REVIEW_GATE_INCOMPLETE',409);
          if(gate.startsWith('review-')){
            const bytes=await readFile(join(this.missionDir(missionId),state.artifactPath));
            const review=JSON.parse(bytes.toString('utf8'));
            if(review.status!=='PASS_RECOMMENDED')fail('PUBLICATION_REVIEW_NOT_PASSED',409);
          }
        }
      }
      const artifact={
        decision:'approved',taskId,missionId,approvedBy:approvedBy.trim(),
        approvedAt:new Date(this.clock()).toISOString(),
        approvedArtifactSha256,
        sourceSha256:record.plan.binding.sourceSha256,
      };
      const bytes=Buffer.from(JSON.stringify(artifact,null,2)+'\n');
      const artifactSha256=hash(bytes),artifactPath='artifacts/'+taskId+'.json';
      await writeFile(join(this.missionDir(missionId),artifactPath),bytes,{mode:0o600,flag:'w'});
      record.tasks[taskId]={state:'completed',attempts:0,artifactPath,artifactSha256,completedAt:this.clock(),updatedAt:this.clock()};
      record.approvals=[...new Set([...record.approvals,task.humanGate])];
      if(taskId==='human-release-approval'){
        // The human approved the reviewed private preview. Public deployment is a separate, unimplemented gate.
        record.publication={state:'approved-private-preview',publicReleaseSupported:false,publicPublication:'blocked'};
      }
      this.refreshReady(record);
      await this.save(record);
      return publicMission(record);
    });
  }

  async retryTask({missionId,taskId}={}){
    return this.exclusive(async()=>{
      const record=this.records.get(missionId);
      if(!record)fail('MISSION_NOT_FOUND',404);
      const task=record.plan.tasks.find(item=>item.id===taskId);
      if(!task)fail('MISSION_TASK_NOT_FOUND',404);
      const state=record.tasks[taskId];
      if(state.state!=='failed'||state.attempts>=MAX_ATTEMPTS)fail('MISSION_TASK_NOT_RETRYABLE',409);
      state.state='blocked';delete state.error;delete state.reason;delete state.dispatch;delete state.dispatchError;delete state.accessHash;delete state.accessExpiresAt;
      this.refreshReady(record);
      await this.save(record);
      if(state.state!=='queued')fail('MISSION_TASK_GATES_UNMET',409);
      return publicMission(record);
    });
  }

  async readArtifactBytes(missionId,taskId){
    const record=this.records.get(missionId);
    const state=record?.tasks?.[taskId];
    if(!state||state.state!=='completed'||!state.artifactPath)fail('MISSION_ARTIFACT_NOT_READY',409);
    const bytes=await readFile(join(this.missionDir(missionId),state.artifactPath));
    if(hash(bytes)!==state.artifactSha256)fail('MISSION_ARTIFACT_CHANGED',503);
    return bytes;
  }

  getDirectory(missionId){return this.missionDir(missionId);}
  getTeamMapProjection(missionId,tenantId){
    const record=this.records.get(missionId);
    if(!record)fail('MISSION_NOT_FOUND',404);
    if(tenantId&&record.plan.binding.tenantId!==tenantId)fail('MISSION_NOT_FOUND',404);
    const tasksBySeat=new Map(manifest.seats.map(seat=>[seat.id,[]]));
    for(const task of record.plan.tasks){
      const list=tasksBySeat.get(task.seatId);
      if(!list)continue;
      const state=record.tasks[task.id];
      list.push({task,state});
    }
    const seats=manifest.seats.map(seat=>{
      const rows=tasksBySeat.get(seat.id)||[];
      const counts={blocked:0,queued:0,running:0,completed:0,failed:0};
      for(const row of rows)if(Object.hasOwn(counts,row.state.state))counts[row.state.state]+=1;
      const current=rows.find(row=>row.state.state==='running')||
        rows.find(row=>row.state.state==='queued')||
        rows.find(row=>row.state.state==='blocked')||
        rows.find(row=>row.state.state==='failed')||null;
      const completed=rows.filter(row=>row.state.state==='completed'&&row.state.artifactSha256);
      const dispatched=rows.find(row=>row.state.dispatch?.botId);
      const status=counts.running?'working':
        counts.queued?'queued':
        counts.blocked||counts.failed?'waiting':'idle';
      return {
        seatId:seat.id,
        title:seat.title,
        botId:dispatched?.state.dispatch.botId||null,
        threadId:current?.state.dispatch?.threadId||dispatched?.state.dispatch.threadId||null,
        status,
        currentTask:current?{
          id:current.task.id,
          state:current.state.state,
          updatedAt:current.state.updatedAt,
          reason:current.state.reason||null,
          errorCode:current.state.error?.code||null,
        }:null,
        taskCounts:counts,
        filePileCount:completed.length,
        files:completed.map(({task,state})=>({
          taskId:task.id,
          label:task.output,
          sha256:state.artifactSha256,
          updatedAt:state.updatedAt,
        })),
        updatedAt:rows.reduce((latest,row)=>Math.max(latest,row.state.updatedAt||0),0)||null,
      };
    });
    return {
      schemaVersion:'buyersite-team-map/v1',
      missionId:record.id,
      issueId:record.plan.binding.issueId,
      jobId:record.job.id,
      enterpriseId:record.job.enterpriseId,
      state:record.state,
      seats,
      publication:clone(record.publication),
      updatedAt:record.updatedAt,
    };
  }

  getPublicMission(missionId){return publicMission(this.records.get(missionId)||fail('MISSION_NOT_FOUND',404));}
}
