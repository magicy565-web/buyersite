import { randomUUID } from 'node:crypto';
import manifest from './department.json' with { type: 'json' };

const fail=(code,status=503)=>{const error=new Error(code);error.code=code;error.status=status;throw error;};
const safe=(value,max=200)=>typeof value==='string'?value.slice(0,max):'';
const titleFor=(task,missionId)=>'BuyerSite · '+task.id+' · '+missionId.slice(-8);

function seatBotFor(seatId,bots){
  const seat=manifest.seats.find(item=>item.id===seatId);
  if(!seat)fail('EDITORIAL_SEAT_UNKNOWN',404);
  const matches=bots.filter(bot=>bot&&bot.name===seat.title&&
    bot.section===manifest.workspace.sectionName&&!bot.hidden);
  if(matches.length!==1)fail(matches.length?'OPENMAUSBOT_SEAT_AMBIGUOUS':'OPENMAUSBOT_SEAT_NOT_FOUND',409);
  const bot=matches[0];
  if(typeof bot.id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(bot.id))fail('OPENMAUSBOT_BOT_ID_INVALID',409);
  return bot;
}

function taskInstructions(task){
  const tools={
    'capture-source':['buyersite_source_capture'],
    'compile-enterprise':['buyersite_enterprise_compile'],
    'editorial-outline':['buyersite_task_complete'],
    'draft-editorial-copy':['buyersite_task_complete'],
    'art-direction':['buyersite_task_complete'],
    'prepare-media':['buyersite_media_materialize'],
    'compile-issue':['buyersite_issue_compile'],
    'build-private-preview':['buyersite_issue_build_preview'],
    'review-content':['buyersite_review_content'],
    'review-media':['buyersite_review_media'],
    'review-visuals':['buyersite_review_visuals'],
    'verify-output':['buyersite_verify_output'],
    'skip-product-gallery':['buyersite_task_complete'],
  };
  return ['buyersite_mission_get','buyersite_task_claim','buyersite_task_complete','buyersite_task_fail',...(tools[task.id]||[])];
}

export function buildSeatTaskPrompt({missionId,task,context}={}){
  if(!missionId||!task||!context||context.missionId!==missionId||context.task?.id!==task.id)fail('MISSION_PROMPT_CONTEXT_INVALID',500);
  const output={
    missionId,
    taskId:task.id,
    seatId:task.seatId,
    sourceSha256:context.binding.sourceSha256,
    enterpriseId:context.binding.tenantId,
    issueId:context.binding.issueId,
    selectedProductCount:context.binding.selectedProductCount,
    requiredApprovals:task.requiredApprovals,
    expectedOutput:task.output,
    availableTools:taskInstructions(task),
  };
  const prompt=[
    'You have been assigned one durable BuyerSite Editorial Mission task.',
    'Follow your installed editorial-department, buyersite-production and seat-specific Skills.',
    'Do not claim completion in chat. Claim the task through the BuyerSite MCP tool, perform only this task, and submit the exact typed artifact through the MCP tool. The runtime will validate evidence IDs, hashes and task ownership.',
    'Never invent supplier facts, prices, MOQ, lead times, certifications, factory claims, interviews, buyer demand or commercial outcomes. Do not contact suppliers, submit buyer enquiries, create quotes/orders, publish or distribute externally.',
    'If required evidence or authorization is missing, call the task failure tool with a concise blocker. Do not simulate work or fabricate a PASS review.',
    'Use buyersite_mission_get to retrieve this task context, then buyersite_task_claim. Use only the task-specific tools listed below. The host records durable task state and will dispatch dependent tasks after a valid completion.',
    'TASK CONTRACT:',
    JSON.stringify(output,null,2),
    'TASK CONTEXT:',
    JSON.stringify(context,null,2),
  ].join('\n\n');
  if(prompt.length>78_000)fail('MISSION_PROMPT_TOO_LARGE',413);
  return prompt;
}

export function createEditorialDispatcher({runtime,openMausClient,clock=()=>Date.now()}={}){
  if(!runtime||!openMausClient||typeof openMausClient.listBots!=='function'||
     typeof openMausClient.createTask!=='function'||typeof openMausClient.sendGoal!=='function') {
    fail('EDITORIAL_DISPATCHER_DEPENDENCIES_REQUIRED',500);
  }
  let tail=Promise.resolve();
  const dispatch=missionId=>{
    const run=tail.then(()=>dispatchNow(missionId),()=>dispatchNow(missionId));
    tail=run.then(()=>undefined,()=>undefined);
    return run;
  };
  async function dispatchNow(missionId){
    const queued=runtime.getQueuedTasks(missionId);
    if(!queued.length)return {missionId,dispatched:[],pending:[]};
    const bots=await openMausClient.listBots();
    if(!Array.isArray(bots))fail('OPENMAUSBOT_BOT_LIST_INVALID',502);
    const dispatched=[],pending=[];
    const limit=manifest.missionPolicy.maxParallelTasks;
    for(const entry of queued.slice(0,limit)){
      const task=entry.task;
      try{
        const bot=seatBotFor(task.seatId,bots);
        let dispatch=entry.state.dispatch;
        if(!dispatch){
          const title=titleFor(task,missionId);
          const existing=Array.isArray(bot.tasks)?bot.tasks.find(item=>item?.title===title&&
            typeof item.threadId==='string'&&!item.archivedAt):null;
          const created=existing?{task:existing,threadId:existing.threadId}:await openMausClient.createTask(bot.id,title);
          const sendId=randomUUID();
          dispatch={seatId:task.seatId,botId:bot.id,threadId:created.threadId,sendId};
          await runtime.recordDispatchTarget({missionId,taskId:task.id,...dispatch});
        }
        if(dispatch.state==='sent'){
          dispatched.push({taskId:task.id,seatId:task.seatId,threadId:dispatch.threadId,reused:true});
          continue;
        }
        const context=await runtime.getTaskContext(missionId,task.id,task.seatId);
        const prompt=buildSeatTaskPrompt({missionId,task,context});
        await openMausClient.sendGoal(dispatch.botId,dispatch.threadId,prompt,dispatch.sendId);
        await runtime.recordDispatchSent({missionId,taskId:task.id,seatId:task.seatId,threadId:dispatch.threadId});
        dispatched.push({taskId:task.id,seatId:task.seatId,threadId:dispatch.threadId,reused:Boolean(entry.state.dispatch)});
      }catch(error){
        await runtime.recordDispatchError({missionId,taskId:task.id,seatId:task.seatId,code:error.code||'DISPATCH_FAILED'}).catch(()=>{});
        pending.push({taskId:task.id,code:error.code||'DISPATCH_FAILED'});
      }
    }
    return {missionId,dispatched,pending,remaining:Math.max(0,queued.length-dispatched.length-pending.length)};
  }
  return Object.freeze({dispatch});
}
