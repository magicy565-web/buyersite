import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const ID=/^[a-z][a-z0-9-]{1,79}$/;
const SAFE_BOT=/^[A-Za-z0-9_-]{1,128}$/;
const SCHEMA='buyersite-openmaus-seat-bindings/v1';

export function createSeatBindings({bots,packageDocument,hostOrigin,now=()=>new Date().toISOString()}={}) {
  const pkg=packageDocument?.package;
  if(!Array.isArray(bots)||!Array.isArray(pkg?.agents)||pkg.agents.length!==7||
     typeof pkg.team?.name!=='string'||!pkg.team.name.trim()||
     typeof hostOrigin!=='string'||!/^https?:\/\//.test(hostOrigin)) {
    throw new TypeError('A complete seven-seat package and OpenMausBot roster are required');
  }
  const visible=bots.filter(bot=>!bot.hidden);
  const seats={};
  const used=new Set();
  for(const agent of pkg.agents) {
    if(!ID.test(agent.key||'')) throw new TypeError('Package contains an unsafe seat key');
    const matches=visible.filter(bot=>bot.section===pkg.team.name && bot.title===agent.title);
    if(matches.length!==1) throw new Error('Expected exactly one imported Bot for seat '+agent.key);
    const bot=matches[0];
    if(!SAFE_BOT.test(bot.id||'')||used.has(bot.id)) throw new Error('Imported Bot IDs are invalid or duplicated');
    const expectedChief=agent.key===pkg.team.leader;
    if(Boolean(bot.chiefOfStaff)!==expectedChief) throw new Error('Chief of Staff assignment does not match '+agent.key);
    used.add(bot.id);
    seats[agent.key]={botId:bot.id,title:bot.title,threadId:bot.threadId};
  }
  if(Object.keys(seats).length!==7 || used.size!==7) throw new Error('All seven editorial seats must be bound exactly once');
  return {
    schemaVersion:SCHEMA,
    packageId:pkg.id,
    packageRelease:pkg.release,
    section:pkg.team.name,
    chiefSeatId:pkg.team.leader,
    hostOrigin:new URL(hostOrigin).origin,
    seats,
    bindingId:randomUUID(),
    boundAt:now(),
    credentialStorage:'external-secret-store',
  };
}

export function assertSeatBindings(value) {
  if(!value||value.schemaVersion!==SCHEMA||typeof value.packageId!=='string'||
     typeof value.section!=='string'||!value.section.trim()||
     value.chiefSeatId!=='editor-in-chief'||!value.seats||Object.keys(value.seats).length!==7||
     typeof value.hostOrigin!=='string'||!/^https?:\/\//.test(value.hostOrigin)||
     value.credentialStorage!=='external-secret-store') throw new TypeError('Invalid OpenMausBot seat binding file');
  const ids=new Set();
  for(const [seatId,seat] of Object.entries(value.seats)) {
    if(!ID.test(seatId)||!seat||!SAFE_BOT.test(seat.botId||'')||ids.has(seat.botId)||
       typeof seat.title!=='string'||!seat.title.trim()||
       (seat.threadId!==undefined && !/^[\w-]{1,128}$/.test(seat.threadId))) {
      throw new TypeError('Invalid or duplicate Bot binding for '+seatId);
    }
    ids.add(seat.botId);
  }
  if(!value.seats['editor-in-chief']) throw new TypeError('Editor-in-Chief binding is required');
  return value;
}

export async function writeSeatBindings(path,value) {
  assertSeatBindings(value);
  const target=resolve(path);
  await mkdir(dirname(target),{recursive:true,mode:0o700});
  const temporary=target+'.'+process.pid+'.tmp';
  await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
  await chmod(temporary,0o600);
  await rename(temporary,target);
  return target;
}

export async function readSeatBindings(path) {
  const value=JSON.parse(await readFile(resolve(path),'utf8'));
  return assertSeatBindings(value);
}