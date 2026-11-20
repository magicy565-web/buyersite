import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenMausBotClient } from './openmaus-client.mjs';
import { createSeatBindings, writeSeatBindings } from './seat-bindings.mjs';

const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const PACKAGE_PATH=resolve(ROOT,'editorial-department/openmaus.package.json');
const APPLY=process.argv.includes('--apply');
const baseUrl=process.env.OPENMAUSBOT_URL;
const token=process.env.OPENMAUSBOT_SESSION_TOKEN;
const output=process.env.BUYERSITE_EDITORIAL_BINDINGS;
if(!baseUrl||!token||!output) {
  console.error('Set OPENMAUSBOT_URL, OPENMAUSBOT_SESSION_TOKEN and BUYERSITE_EDITORIAL_BINDINGS. The token is read from the environment and is never written to the binding file.');
  process.exit(2);
}
const packageDocument=JSON.parse(await readFile(PACKAGE_PATH,'utf8'));
const client=createOpenMausBotClient({baseUrl,token});
const roster=await client.listBots();
const expected=packageDocument.package.agents;
const existing=roster.filter(bot=>bot.section===packageDocument.package.team.name);
if(existing.length!==0 && existing.length!==expected.length) {
  throw new Error('A partial BuyerSite Editorial Department already exists in this OpenMausBot workspace. Reconcile it manually; refusing to create duplicates.');
}
if(existing.length===expected.length) {
  // Existing team is accepted only if every role and Chief of Staff matches exactly.
  const bindings=createSeatBindings({bots:roster,packageDocument,hostOrigin:client.origin});
  if(!APPLY) {
    console.log(JSON.stringify({status:'ALREADY_INSTALLED',section:bindings.section,seats:Object.keys(bindings.seats),next:'Run again with --apply to refresh the local ID binding file.'},null,2));
  } else {
    await writeSeatBindings(output,bindings);
    console.log(JSON.stringify({status:'BINDINGS_REFRESHED',section:bindings.section,bindingFile:resolve(output),seats:Object.keys(bindings.seats)},null,2));
  }
} else if(!APPLY) {
  console.log(JSON.stringify({
    status:'DRY_RUN',
    package:packageDocument.package.name,
    botsToImport:expected.map(agent=>({key:agent.key,title:agent.title,approval:agent.approval})),
    section:packageDocument.package.team.name,
    chief:packageDocument.package.team.leader,
    bindingFile:resolve(output),
    next:'Run with --apply to import the seven role Bots and save their returned IDs.',
  },null,2));
} else {
  const imported=await client.importPackage(packageDocument);
  if(imported.alreadyAdded) {
    throw new Error('OpenMausBot reported an existing package install without a complete roster. Inspect the workspace before retrying.');
  }
  const updatedRoster=await client.listBots();
  const bindings=createSeatBindings({bots:updatedRoster,packageDocument,hostOrigin:client.origin});
  await writeSeatBindings(output,bindings);
  console.log(JSON.stringify({
    status:'IMPORTED_AND_BOUND',
    section:bindings.section,
    chiefSeatId:bindings.chiefSeatId,
    seatCount:Object.keys(bindings.seats).length,
    bindingFile:resolve(output),
    note:'No session token or MCP credential was written to disk.',
  },null,2));
}