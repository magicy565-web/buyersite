import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { assertCurrentLicensedSelection } from '../site-builder/media-rights.mjs';
import { normalizeLicensedPhoto } from '../site-builder/media-render.mjs';
const load = async p => JSON.parse(await readFile(p, 'utf8'));
const ajv = new Ajv({allErrors:true,strict:false}); addFormats(ajv);
const validators = Object.fromEntries(await Promise.all(['site-manifest','magazine-page','site-evidence'].map(async name => [name,ajv.compile(await load('legacy/schemas/'+name+'.schema.json'))])));
const editionRoot = process.env.BUYERSITE_BUILD_ROOT;
if (editionRoot) {
  const root = (name) => editionRoot.replace(/\/$/, '') + '/' + name;
  const [manifest, pages, evidence, site, snapshots, visualPlan, mediaPlan, mediaReport, buildReceipt] = await Promise.all(
    ['manifest.json', 'pages.json', 'evidence.json', 'site.json', 'sources.json', 'visual-plan.json', 'media-plan.json', 'media-report.json', 'receipt.json'].map((name) => load(root(name)))
  );
  const check = (name, value) => {
    if (!validators[name](value)) throw Error(name + ': ' + JSON.stringify(validators[name].errors));
  };
  check('site-manifest', manifest);
  if (manifest.site_slug !== site.slug || !site.privatePreview || manifest.assistant.enabled) {
    throw Error('Enterprise edition must remain isolated private preview');
  }
  if (pages.length !== manifest.routes.length || !pages.length) throw Error('Site route mismatch');
  if (!['atelier', 'industrial', 'editorial'].includes(visualPlan.direction) ||
      manifest.design_system.direction !== visualPlan.direction ||
      site.designDirection !== visualPlan.direction ||
      visualPlan.images.length !== pages.length - 1) {
    throw Error('Missing or inconsistent editorial design plan');
  }
  {
    // The layout plan must be exactly what the planner derives from this pack's own records.
    const { planEditionLayout, validateLayoutPlan, layoutInputsFromPack } = await import('../site-builder/layout-planner.mjs');
    const layoutPlan = validateLayoutPlan(await load(root('layout-plan.json')), pages.filter((p) => p.page_type !== 'home').map((p) => p.page_id));
    const replanned = planEditionLayout(layoutInputsFromPack({ pages, evidence, mediaReport, site, visualPlan }));
    if (replanned.plan_sha256 !== layoutPlan.plan_sha256) throw Error('LAYOUT_PLAN_DRIFT: layout-plan.json does not match the planner output for this pack');
  }
  const mediaFiles = new Map();
  if (!Array.isArray(mediaPlan.selections) || !Array.isArray(mediaReport.images) ||
      !/^[a-f0-9]{64}$/.test(mediaPlan.plan_sha256 || '') ||
      createHash('sha256').update(JSON.stringify(mediaPlan.selections)).digest('hex') !== mediaPlan.plan_sha256 ||
      mediaPlan.plan_sha256 !== mediaReport.plan_sha256 ||
      mediaPlan.selections.length !== visualPlan.images.length ||
      mediaReport.images.length !== visualPlan.images.length ||
      new Set(mediaPlan.selections.map((entry) => entry?.page_id)).size !== mediaPlan.selections.length ||
      mediaReport.publication !== 'BLOCKED' ||
      mediaReport.review_required !== true) {
    throw Error('Media plan/report mismatch or review gate missing');
  }
  for (const photo of mediaReport.images) {
    if (!photo || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(photo.page_id || '') || mediaFiles.has(photo.page_id) ||
        !['licensed-photo', 'ai-generated', 'abstract-fallback'].includes(photo.kind) ||
        photo.filename !== 'hero-' + photo.page_id + '.png' ||
        !/^[a-f0-9]{64}$/.test(photo.sha256 || '')) {
      throw Error('Untrusted media report entry');
    }
    const selected = mediaPlan.selections.find((entry) => entry.page_id === photo.page_id);
    if (!selected || !visualPlan.images.some((entry) => entry.page_id === photo.page_id) ||
        (photo.kind === 'licensed-photo' && (selected.media_kind !== 'licensed-photo' ||
          photo.source_sha256 !== selected.source_sha256 || photo.grant_sha256 !== selected.grant_sha256 ||
          photo.asset_id !== selected.asset_id || photo.rights_sha256 !== selected.rights_sha256 || photo.alt !== selected.alt || photo.credit !== selected.credit ||
          (photo.rights_expires_at || null) !== (selected.expires_at || null))) ||
        (photo.kind !== 'licensed-photo' && (selected.media_kind !== 'generation-requested' ||
          photo.source_sha256 !== null || photo.grant_sha256 !== null))) {
      throw Error('Rendered media is not bound to its exact frozen plan selection');
    }
    if (photo.kind === 'licensed-photo' && photo.rights_expires_at && Date.parse(photo.rights_expires_at) <= Date.now()) {
      throw Error('Licensed media publication rights expired before build');
    }
    if (photo.kind === 'licensed-photo') {
      const { sourceBytes } = await assertCurrentLicensedSelection({
        asset: selected, enterpriseId: buildReceipt.enterprise_id, mediaRoot: process.env.BUYERSITE_MEDIA_ROOT,
      });
      if (createHash('sha256').update(await normalizeLicensedPhoto(sourceBytes)).digest('hex') !== photo.sha256) throw Error('Licensed output differs from its authorized source');
    }
    const raw = await readFile(root('articles/' + photo.filename));
    const digest = (await import('node:crypto')).createHash('sha256').update(raw).digest('hex');
    if (digest !== photo.sha256) throw Error('Generated hero changed after media review');
    if (photo.kind === 'licensed-photo' && (!/^[a-f0-9]{64}$/.test(photo.grant_sha256 || '') ||
        !/^[a-f0-9]{64}$/.test(photo.source_sha256 || ''))) {
      throw Error('Licensed photograph is missing provenance or grant hash');
    }
    if (photo.kind === 'ai-generated' && (!photo.generation_model || !photo.generation_provider ||
        typeof photo.prompt !== 'string' || createHash('sha256').update(photo.prompt).digest('hex') !== photo.prompt_sha256)) {
      throw Error('Generated media missing image model or prompt digest');
    }
    if (photo.kind !== 'licensed-photo' && !/not (?:a supplier |product )?photograph|conceptual artwork/i.test(photo.caption + ' ' + photo.credit)) {
      throw Error('Non-photographic visual must be described as conceptual artwork');
    }
    mediaFiles.set(photo.page_id, photo);
  }
  const visualAssets = new Map();
  for (const artwork of visualPlan.images) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(artwork.page_id) ||
        artwork.asset !== 'hero-' + artwork.page_id + '.png' ||
        artwork.source !== 'original-abstract-illustration' ||
        visualAssets.has(artwork.page_id)) throw Error('Unsafe or duplicated artwork plan');
    const bytes = await readFile(root('articles/' + artwork.asset));
    if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
      throw Error('Invalid generated artwork: ' + artwork.page_id);
    }
    visualAssets.set(artwork.page_id, artwork);
  }
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
      const artwork = visualAssets.get(page.page_id);
      const resolvedMedia = mediaFiles.get(page.page_id);
      if (!artwork || !resolvedMedia || !article.includes('hero: "./' + artwork.asset + '"') ||
          !article.includes(JSON.stringify(resolvedMedia.credit))) {
        throw Error('Article hero is not bound to visual plan: ' + page.page_id);
      }
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
const publication=await load('src/data/publication.json');
const publicRelease=publication.mode==='public';
await (await import('./release-gate.mjs')).assertPublicRelease();
const evidence = await load('src/data/evidence.json'); const pilot = await load('src/data/pilot.json');
const ids = new Set(evidence.map(e => e.evidence_id)); if(ids.size !== evidence.length) throw Error('Duplicate evidence IDs');
const pages = [{page_id:'home',path:'/',page_type:'home',title:'Material Notes: a review for interior material buyers',description:'Review wool fabric specifications, supplier evidence and purchasing questions before preparing a sourcing enquiry.',h1:'Material Notes',intent:'Evaluate sourcing evidence for interior material purchases.',sections:[{type:'answer',heading:'Start with the specification',body:'Review the material, supplier and project brief.'},{type:'editorial',heading:'Before requesting an offer',body:'Commercial terms require supplier confirmation.'}],evidence_refs:[...ids]},...pilot.articles.map(a => ({page_id:a.slug,path:'/'+a.desk+'/'+a.slug+'/',page_type:a.type,title:a.title,description:a.deck,h1:a.title,intent:'Review evidence before requesting a project-specific supplier offer.',sections:a.sections.map(([heading,body]) => ({type:'editorial',heading,body})),evidence_refs:a.refs}))].map(p => ({...p,locale:'en',primary_cta:{label:'Prepare an enquiry',action:'request-quote',target:'/enquiry'},indexable:publicRelease}));
const manifest = {schema_version:'1.0.0',site_slug:'material-notes',publication:{name:'Material Notes',kind:'supplier-edition',primary_category:'Interior materials',supplier_public_id:pilot.supplier_id},locale:'en',base_url:process.env.SITE_URL || publication.origin,routes:pages.map(p => ({path:p.path,page_id:p.page_id,page_type:p.page_type,indexable:publicRelease})),design_system:{direction:'halftone',tokens_ref:'src/styles/theme.css',motion:'reduced'},assistant:{enabled:!!process.env.PUBLIC_ASSISTANT_API_BASE,api_base_url:process.env.PUBLIC_ASSISTANT_API_BASE || null,public_site_slug:'material-notes',features:['product-qa','supplier-qa']}};
function check(name,value){if(!validators[name](value))throw Error(name+': '+JSON.stringify(validators[name].errors));}
check('site-manifest',manifest); for(const e of evidence) check('site-evidence',e);
for(const article of pilot.articles){const raw=await readFile('src/content/articles/'+article.slug+'.md','utf8');for(const text of [article.title,article.deck,...article.sections.flat(),...article.refs]) if(!raw.includes(text))throw Error('Article/contract drift: '+article.slug);}
for(const page of pages){check('magazine-page',page);for(const id of page.evidence_refs)if(!ids.has(id))throw Error('Dangling evidence: '+id);if(page.indexable && page.evidence_refs.some(id=>evidence.find(e=>e.evidence_id===id).publication_permission!=='approved'))throw Error('Unapproved evidence in indexed page');}
await mkdir('.generated',{recursive:true});
await writeFile('.generated/site-manifest.json',JSON.stringify(manifest,null,2));
await writeFile('.generated/pages.json',JSON.stringify(pages,null,2));
console.log('Validated 1 manifest, '+pages.length+' page contracts and '+evidence.length+' evidence records. Public indexing: '+publicRelease+'.');
