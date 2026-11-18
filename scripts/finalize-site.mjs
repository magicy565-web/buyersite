import { readFile, writeFile, mkdir, readdir, rename, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createIndex, close } from 'pagefind';
import { build } from 'esbuild';
import { assertPublicRelease } from './release-gate.mjs';
await assertPublicRelease();
const edition=process.env.BUYERSITE_BUILD_ROOT;
const pages=JSON.parse(await readFile(edition?join(edition,'pages.json'):'.generated/pages.json','utf8'));
const evidence=JSON.parse(await readFile(edition?join(edition,'evidence.json'):'src/data/evidence.json','utf8'));
const {index,errors}=await createIndex({forceLanguage:'en',writePlayground:false});
if(errors.length||!index)throw Error('SEARCH_INDEX_FAILED: '+errors.join(';'));
try{
  for(const page of pages.filter(x=>x.page_type!=='home')){
    const content=[page.title,page.description,...page.sections.map(x=>x.heading+' '+x.body),...page.evidence_refs.map(id=>{const e=evidence.find(e=>e.evidence_id===id);return e?`${e.claim}: ${e.value}`:'';})].join('\n');
    const result=await index.addCustomRecord({url:page.path,content,language:page.locale||'en',meta:{title:page.title},filters:{type:[page.page_type]}});
    if(result.errors.length)throw Error('SEARCH_RECORD_FAILED');
  }
  const output=await index.writeFiles({outputPath:'dist/pagefind'});if(output.errors.length)throw Error('SEARCH_WRITE_FAILED');
}finally{await close();}
if(edition){console.log('Finalized private edition with isolated local search.');process.exit(0);}
const publication=JSON.parse(await readFile('src/data/publication.json','utf8'));
const manifest=JSON.parse(await readFile('.generated/site-manifest.json','utf8'));
const knowledge=JSON.parse(await readFile('dist/buyer-data.json','utf8'));
const config={siteSlug:manifest.site_slug,siteName:manifest.publication.name,publication:publication.mode,enquiriesEnabled:publication.enquiriesEnabled,analyticsEnabled:publication.analyticsEnabled,origin:publication.origin,allowedPaths:[...pages.map(p=>p.path),'/enquiry','/search','/colophon','/privacy','/sources','/materials','/suppliers','/guides'],buyerBriefs:knowledge.briefs,knowledgeRevision:knowledge.revision};
config.sourceRecords=pages.filter(p=>p.page_type!=='home').flatMap(page=>page.evidence_refs.map(id=>{
  const record=evidence.find(e=>e.evidence_id===id&&e.publication_permission==='approved');
  return record?{id:record.evidence_id,title:page.title,claim:record.claim,value:record.value,source_url:record.source_url,page_path:page.path,status:record.status,captured_at:record.captured_at}:null;
}).filter(Boolean));
await mkdir('.generated',{recursive:true});
await writeFile('.generated/runtime-config.json',JSON.stringify(config,null,2));
await mkdir('dist/client',{recursive:true});
for(const file of await readdir('dist'))if(!['client','server','.openai'].includes(file))await rename(join('dist',file),join('dist/client',file));
await mkdir('dist/server',{recursive:true});
await build({entryPoints:['runtime/index.mjs'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true});
await mkdir('dist/.openai',{recursive:true});
await cp('.openai/hosting.json','dist/.openai/hosting.json');
const media=JSON.parse(await readFile('src/data/concept-media.json','utf8'));
await writeFile('dist/client/media-provenance.json',JSON.stringify({version:media.version,images:media.assets.map(({page_id,sha256,kind,caption,credit})=>({page_id,sha256,kind,caption,credit}))},null,2));
const inventory=[];
for(const item of (await readdir('dist/client',{recursive:true,withFileTypes:true})).filter(x=>x.isFile())){
  const file=join(item.parentPath,item.name),bytes=await readFile(file);
  inventory.push({path:file.replace(/^dist\/client\//,''),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
inventory.sort((a,b)=>a.path.localeCompare(b.path));
await writeFile('.generated/launch-artifact.json',JSON.stringify({files:inventory,artifact_sha256:createHash('sha256').update(JSON.stringify(inventory)).digest('hex')},null,2));
console.log(`Finalized ${inventory.length} static files, Pagefind, same-origin conversion and aggregate analytics Worker.`);
