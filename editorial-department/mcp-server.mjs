import { createInterface } from 'node:readline';
import { EditorialMissionRuntime } from './runtime.mjs';
import { readSeatBindings } from './seat-bindings.mjs';

const seatId=process.env.BUYERSITE_EDITORIAL_SEAT_ID;
const botId=process.env.BUYERSITE_EDITORIAL_BOT_ID;
const runtimeDir=process.env.BUYERSITE_EDITORIAL_RUNTIME_DIR;
const bindingsPath=process.env.BUYERSITE_EDITORIAL_BINDINGS_FILE;
if(!seatId||!botId||!runtimeDir||!bindingsPath) {
  process.stderr.write('BuyerSite Editorial MCP requires seat, Bot ID, runtime directory and binding file environment variables.\n');
  process.exit(2);
}
const bindings=await readSeatBindings(bindingsPath);
const binding=bindings.seats[seatId];
if(!binding||binding.botId!==botId||bindings.section!=='BuyerSite Editorial Department') {
  process.stderr.write('BuyerSite Editorial MCP identity does not match the imported department binding.\n');
  process.exit(2);
}
const runtime=await new EditorialMissionRuntime({dataDir:runtimeDir}).init();

const text=(value,max=200)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const schema=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const id={type:'string',pattern:'^mission-[a-f0-9]{24}$'};
const task={type:'string',pattern:'^[a-z][a-z0-9-]{1,63}
const tools=[
  {name:'buyersite_mission_get',description:'Read the current mission and the context for one task assigned to this editorial seat.',inputSchema:schema({missionId:id,taskId:task,taskAccessToken},['missionId','taskId','taskAccessToken'])},
  {name:'buyersite_task_claim',description:'Claim an assigned queued task and receive its short-lived lease token.',inputSchema:schema({missionId:id,taskId:task,taskAccessToken},['missionId','taskId','taskAccessToken'])},
  {name:'buyersite_task_complete',description:'Submit a typed task artifact. The Buyersite runtime validates evidence, schema and task ownership before completing it.',inputSchema:schema({missionId:id,taskId:task,taskAccessToken,claimToken:{type:'string',minLength:32,maxLength:128},artifact:{type:'object'}},['missionId','taskId','taskAccessToken','claimToken','artifact'])},
  {name:'buyersite_task_fail',description:'Report a real blocker for an assigned task using its active lease.',inputSchema:schema({missionId:id,taskId:task,taskAccessToken,claimToken:{type:'string',minLength:32,maxLength:128},code:{type:'string',maxLength:80},message:{type:'string',maxLength:500}},['missionId','taskId','taskAccessToken','claimToken','code','message'])},
  {name:'buyersite_artifact_get',description:'Read a completed dependency artifact that this seat is authorized to access.',inputSchema:schema({missionId:id,artifactTaskId:task,currentTaskId:task,taskAccessToken},['missionId','artifactTaskId','currentTaskId','taskAccessToken'])},
];

async function callTool(name,args) {
  if(!args||typeof args!=='object'||Array.isArray(args)) throw new TypeError('Tool arguments must be an object');
  switch(name) {
    case 'buyersite_mission_get': {
      const mission=runtime.getPublicMission(args.missionId);
      const context=await runtime.getTaskContext(args.missionId,args.taskId,seatId,args.taskAccessToken);
      return {mission,context};
    }
    case 'buyersite_task_claim':
      return runtime.claimTask({missionId:args.missionId,taskId:args.taskId,seatId,accessToken:args.taskAccessToken});
    case 'buyersite_task_complete':
      return runtime.completeTask({missionId:args.missionId,taskId:args.taskId,seatId,accessToken:args.taskAccessToken,claimToken:args.claimToken,artifact:args.artifact});
    case 'buyersite_task_fail':
      return runtime.failTask({missionId:args.missionId,taskId:args.taskId,seatId,accessToken:args.taskAccessToken,claimToken:args.claimToken,code:args.code,message:args.message});
    case 'buyersite_artifact_get':
      return runtime.getArtifact(args.missionId,args.artifactTaskId,seatId,args.currentTaskId,args.taskAccessToken);
    default: throw new Error('Unknown BuyerSite Editorial tool');
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message)+'\n');
}
async function handle(message) {
  if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string') return;
  const id=message.id;
  if(message.method==='notifications/initialized'||message.method==='notifications/cancelled') return;
  if(message.method==='initialize') {
    const requested=message.params?.protocolVersion;
    const protocolVersion=['2025-03-26','2024-11-05'].includes(requested)?requested:'2024-11-05';
    return send({jsonrpc:'2.0',id,result:{
      protocolVersion,
      capabilities:{tools:{listChanged:false}},
      serverInfo:{name:'buyersite-editorial-seat',version:'0.1.0'},
    }});
  }
  if(message.method==='ping') return send({jsonrpc:'2.0',id,result:{}});
  if(message.method==='tools/list') return send({jsonrpc:'2.0',id,result:{tools}});
  if(message.method==='tools/call') {
    const name=message.params?.name;
    const args=message.params?.arguments||{};
    try {
      const result=await callTool(name,args);
      return send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],isError:false}});
    } catch(error) {
      const code=typeof error?.code==='string'?error.code:'BUYERSITE_TOOL_FAILED';
      const safeMessage=String(error?.message||'Editorial tool failed').slice(0,500);
      return send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify({error:code,message:safeMessage})}],isError:true}});
    }
  }
  if(id!==undefined) send({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});
}

const lines=createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false});
for await (const line of lines) {
  if(!line.trim()) continue;
  let message;
  try{message=JSON.parse(line);}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});continue;}
  await handle(message);
}
};
const taskAccessToken={type:'string',minLength:32,maxLength:128};
const tools=[
  {name:'buyersite_mission_get',description:'Read the current mission and the context for one task assigned to this editorial seat.',inputSchema:schema({missionId:id,taskId:task},['missionId','taskId'])},
  {name:'buyersite_task_claim',description:'Claim an assigned queued task and receive its short-lived lease token.',inputSchema:schema({missionId:id,taskId:task},['missionId','taskId'])},
  {name:'buyersite_task_complete',description:'Submit a typed task artifact. The Buyersite runtime validates evidence, schema and task ownership before completing it.',inputSchema:schema({missionId:id,taskId:task,claimToken:{type:'string',minLength:32,maxLength:128},artifact:{type:'object'}},['missionId','taskId','claimToken','artifact'])},
  {name:'buyersite_task_fail',description:'Report a real blocker for an assigned task using its active lease.',inputSchema:schema({missionId:id,taskId:task,claimToken:{type:'string',minLength:32,maxLength:128},code:{type:'string',maxLength:80},message:{type:'string',maxLength:500}},['missionId','taskId','claimToken','code','message'])},
  {name:'buyersite_artifact_get',description:'Read a completed dependency artifact that this seat is authorized to access.',inputSchema:schema({missionId:id,artifactTaskId:task,currentTaskId:task},['missionId','artifactTaskId','currentTaskId'])},
];

async function callTool(name,args) {
  if(!args||typeof args!=='object'||Array.isArray(args)) throw new TypeError('Tool arguments must be an object');
  switch(name) {
    case 'buyersite_mission_get': {
      const mission=runtime.getPublicMission(args.missionId);
      const context=await runtime.getTaskContext(args.missionId,args.taskId,seatId);
      return {mission,context};
    }
    case 'buyersite_task_claim':
      return runtime.claimTask({missionId:args.missionId,taskId:args.taskId,seatId});
    case 'buyersite_task_complete':
      return runtime.completeTask({missionId:args.missionId,taskId:args.taskId,seatId,claimToken:args.claimToken,artifact:args.artifact});
    case 'buyersite_task_fail':
      return runtime.failTask({missionId:args.missionId,taskId:args.taskId,seatId,claimToken:args.claimToken,code:args.code,message:args.message});
    case 'buyersite_artifact_get':
      return runtime.getArtifact(args.missionId,args.artifactTaskId,seatId,args.currentTaskId);
    default: throw new Error('Unknown BuyerSite Editorial tool');
  }
}

function send(message) {
  process.stdout.write(JSON.stringify(message)+'\n');
}
async function handle(message) {
  if(!message||message.jsonrpc!=='2.0'||typeof message.method!=='string') return;
  const id=message.id;
  if(message.method==='notifications/initialized'||message.method==='notifications/cancelled') return;
  if(message.method==='initialize') {
    const requested=message.params?.protocolVersion;
    const protocolVersion=['2025-03-26','2024-11-05'].includes(requested)?requested:'2024-11-05';
    return send({jsonrpc:'2.0',id,result:{
      protocolVersion,
      capabilities:{tools:{listChanged:false}},
      serverInfo:{name:'buyersite-editorial-seat',version:'0.1.0'},
    }});
  }
  if(message.method==='ping') return send({jsonrpc:'2.0',id,result:{}});
  if(message.method==='tools/list') return send({jsonrpc:'2.0',id,result:{tools}});
  if(message.method==='tools/call') {
    const name=message.params?.name;
    const args=message.params?.arguments||{};
    try {
      const result=await callTool(name,args);
      return send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(result)}],isError:false}});
    } catch(error) {
      const code=typeof error?.code==='string'?error.code:'BUYERSITE_TOOL_FAILED';
      const safeMessage=String(error?.message||'Editorial tool failed').slice(0,500);
      return send({jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify({error:code,message:safeMessage})}],isError:true}});
    }
  }
  if(id!==undefined) send({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});
}

const lines=createInterface({input:process.stdin,crlfDelay:Infinity,terminal:false});
for await (const line of lines) {
  if(!line.trim()) continue;
  let message;
  try{message=JSON.parse(line);}catch{send({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}});continue;}
  await handle(message);
}
