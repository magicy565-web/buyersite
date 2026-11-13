import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const load = async p => JSON.parse(await readFile(p, 'utf8'));
const ajv = new Ajv({allErrors:true,strict:false}); addFormats(ajv);
const validators = Object.fromEntries(await Promise.all(['site-manifest','magazine-page','site-evidence'].map(async name => [name,ajv.compile(await load('legacy/schemas/'+name+'.schema.json'))])));
const editionRoot = process.env.BUYERSITE_BUILD_ROOT;
if (editionRoot) {
  const root = (name) => editionRoot.replace(/\/$/, '') + '/' + name;
  const [manifest, pages, evidence, site, snapshots] = await Promise.all(
    ['manifest.json', 'pages.json', 'evidence.json', 'site.json', 'sources.json'].map((name) => load(root(name)))
  );
  const check = (name, value) => {
    if (!validators[name](value)) throw Error(name + ': ' + JSON.stringify(validators[name].errors));
  };
  check('site-manifest', manifest);
  if (manifest.site_slug !== site.slug || !site.privatePreview || manifest.assistant.enabled) {
    throw Error('Enterprise edition must remain isolated private preview');
  }
  if (pages.length !== manifest.routes.length || !pages.length) throw Error('Site route mismatch');
  const ids = new Set(evidence.map((item) => item.evidence_id));
  if (ids.size !== evidence.length) throw Error('Duplicate evidence IDs');
  for (const item of evidence) check('site-evidence', item);
  const routes = new Set();
  for (const [i, page] of pages.entries()) {
    check('magazine-page', page);
    const route = manifest.routes[i];
    if (page.path !== route.path || page.page_id !== route.page_id || page.page_type !== route.page_type) {
      throw Error('Page and manifest disagree at ' + i);
    }
    if (page.indexable || route.indexable || page.path.includes('..') || routes.has(page.path)) {
      throw Error('Unsafe or duplicate preview route');
    }
    routes.add(page.path);
    for (const id of page.evidence_refs) if (!ids.has(id)) throw Error('Dangling evidence reference: ' + id);
    if (page.page_type !== 'home') {
      const article = await readFile(root('articles/' + page.page_id + '.md'), 'utf8');
      for (const id of page.evidence_refs) if (!article.includes(id)) throw Error('Missing article evidence reference: ' + id);
    }
  }
  for (const source of snapshots) {
    const digest = (await import('node:crypto')).createHash('sha256').update(source.body_text).digest('hex');
    if (digest !== source.sha256) throw Error('Website snapshot hash mismatch');
  }
  await mkdir('.generated', { recursive: true });
  console.log('Validated private edition: ' + pages.length + ' page contracts, ' + evidence.length + ' evidence, ' + snapshots.length + ' captured sources.');
  process.exit(0);
}
const evidence = await load('src/data/evidence.json'); const pilot = await load('src/data/pilot.json');
const ids = new Set(evidence.map(e => e.evidence_id)); if(ids.size !== evidence.length) throw Error('Duplicate evidence IDs');
const pages = [{page_id:'home',path:'/',page_type:'home',title:'Material Notes: a review for interior material buyers',description:'Review wool fabric specifications, supplier evidence and purchasing questions before preparing a sourcing enquiry.',h1:'Material Notes',intent:'Evaluate sourcing evidence for interior material purchases.',sections:[{type:'answer',heading:'Start with the specification',body:'Review the material, supplier and project brief.'},{type:'editorial',heading:'Before requesting an offer',body:'Commercial terms require supplier confirmation.'}],evidence_refs:[...ids]},...pilot.articles.map(a => ({page_id:a.slug,path:'/'+a.desk+'/'+a.slug+'/',page_type:a.type,title:a.title,description:a.deck,h1:a.title,intent:'Review evidence before requesting a project-specific supplier offer.',sections:a.sections.map(([heading,body]) => ({type:'editorial',heading,body})),evidence_refs:a.refs}))].map(p => ({...p,locale:'en',primary_cta:{label:'Prepare an enquiry',action:'request-quote',target:'/enquiry'},indexable:false}));
const manifest = {schema_version:'1.0.0',site_slug:'material-notes',publication:{name:'Material Notes',kind:'supplier-edition',primary_category:'Interior materials',supplier_public_id:pilot.supplier_id},locale:'en',base_url:process.env.SITE_URL || 'https://buyer-magazine.invalid',routes:pages.map(p => ({path:p.path,page_id:p.page_id,page_type:p.page_type,indexable:false})),design_system:{direction:'halftone',tokens_ref:'src/styles/theme.css',motion:'reduced'},assistant:{enabled:!!process.env.PUBLIC_ASSISTANT_API_BASE,api_base_url:process.env.PUBLIC_ASSISTANT_API_BASE || null,public_site_slug:'material-notes',features:['product-qa','supplier-qa']}};
function check(name,value){if(!validators[name](value))throw Error(name+': '+JSON.stringify(validators[name].errors));}
check('site-manifest',manifest); for(const e of evidence) check('site-evidence',e);
for(const article of pilot.articles){const raw=await readFile('src/content/articles/'+article.slug+'.md','utf8');for(const text of [article.title,article.deck,...article.sections.flat(),...article.refs]) if(!raw.includes(text))throw Error('Article/contract drift: '+article.slug);}
for(const page of pages){check('magazine-page',page);for(const id of page.evidence_refs)if(!ids.has(id))throw Error('Dangling evidence: '+id);if(page.indexable && page.evidence_refs.some(id=>evidence.find(e=>e.evidence_id===id).publication_permission!=='approved'))throw Error('Unapproved evidence in indexed page');}
await mkdir('.generated',{recursive:true});
await writeFile('.generated/site-manifest.json',JSON.stringify(manifest,null,2));
await writeFile('.generated/pages.json',JSON.stringify(pages,null,2));
console.log('Validated 1 manifest, '+pages.length+' page contracts and '+evidence.length+' evidence records. Review only.');
