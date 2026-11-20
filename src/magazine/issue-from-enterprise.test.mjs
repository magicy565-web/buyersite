import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compileMagazineIssueFromEnterprise, assertIssueMediaFiles } from './issue-from-enterprise.mjs';
import { acceptMagazineProposal } from './compose-issue.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const sha=char=>char.repeat(64);
function fixture(withProduct=true){
  const articles=[
    {slug:'supplier-profile',pageType:'supplier-profile',title:'Example Company: supplier profile',deck:'Review the company record and public website statements.',refs:['enterprise-company','website-1'],sections:[['What the company states','Company description from the approved enterprise record.']]},
    ...(withProduct?[{slug:'cat-companion',pageType:'product-editorial',title:'Cat companion: buyer review',deck:'A buyer-facing overview from the product record.',refs:['enterprise-product-1'],sections:[['Product scope','Supplier-stated product description.']]}]:[]),
    {slug:'buyer-enquiry-guide',pageType:'buyer-guide',title:'Prepare a supplier enquiry',deck:'A clear brief helps buyers compare terms.',refs:[],sections:[['Specify the product','Share the intended application and quantity.'],['Confirm terms','Ask the supplier to confirm MOQ, price and lead time.']]},
  ];
  const evidence=[
    {evidence_id:'enterprise-company',claim:'Company description',value:'Example company profile',status:'supplier-stated',source_url:null,source_quote:null,captured_at:'2026-11-20T00:00:00.000Z',publication_permission:'internal-only',notes:'Not independently verified'},
    {evidence_id:'website-1',claim:'Website page: About',value:'About the company',status:'supplier-stated',source_url:'https://example.com/about',source_quote:'About the company',captured_at:'2026-11-20T00:00:00.000Z',publication_permission:'public-source-review-only',notes:'Captured public website text'},
    ...(withProduct?[{evidence_id:'enterprise-product-1',claim:'Enterprise product: Cat companion',value:'A plush cat companion',status:'supplier-stated',source_url:null,source_quote:null,captured_at:'2026-11-20T00:00:00.000Z',publication_permission:'internal-only',notes:'Not independently verified'}]:[]),
  ];
  const compiled={fingerprint:sha('a'),site:{slug:'example-company',name:'Example Company | Buyer Notes',description:'A source-backed buyer review.'},visualPlan:{direction:'editorial'},articles,evidence};
  const chapters=[
    {id:'cover',layout:'cover',purpose:'intro',article_ids:['supplier-profile'],evidence_refs:['enterprise-company','website-1']},
    {id:'contents',layout:'contents',purpose:'navigation',article_ids:[],evidence_refs:[]},
    {id:'company-story',layout:'story',purpose:'story',article_ids:['supplier-profile'],evidence_refs:['enterprise-company','website-1']},
    ...(withProduct?[{id:'product-portfolio',layout:'gallery',purpose:'selected products',article_ids:['cat-companion'],evidence_refs:['enterprise-product-1']}]:[]),
    {id:'source-notebook',layout:'notes',purpose:'facts',article_ids:['supplier-profile',...(withProduct?['cat-companion']:[])],evidence_refs:evidence.map(x=>x.evidence_id)},
    {id:'buyer-questions',layout:'notes',purpose:'questions',article_ids:['buyer-enquiry-guide'],evidence_refs:[]},
    {id:'sourcing',layout:'sourcing',purpose:'enquiry',article_ids:['buyer-enquiry-guide'],evidence_refs:[]},
  ];
  const outlineBody={schema_version:'1.0.0',kind:'source-bound-magazine-outline',publication_status:'private-review',source_fingerprint:compiled.fingerprint,site_slug:compiled.site.slug,brand:compiled.site.name,design_direction:'editorial',chapters,media_policy:'bind-after-rights-check',approval_required:['editorial-content','media-rights','visual-review','enquiry-backend','release']};
  const outline={...outlineBody,outline_sha256:hash(JSON.stringify(outlineBody))};
  const selections=articles.map(a=>{
    if(a.slug==='supplier-profile')return {page_id:a.slug,media_kind:'licensed-photo',asset_id:'supplier-photo',source_sha256:sha('b'),grant_sha256:sha('c'),rights_sha256:sha('d')};
    return {page_id:a.slug,media_kind:'generation-requested'};
  });
  const mediaPlan={selections,plan_sha256:hash(JSON.stringify(selections))};
  const images=articles.map(a=>{
    if(a.slug==='supplier-profile')return {page_id:a.slug,filename:'hero-'+a.slug+'.png',kind:'licensed-photo',sha256:sha('e'),source_sha256:sha('b'),grant_sha256:sha('c'),rights_sha256:sha('d'),asset_id:'supplier-photo',alt:'Authorized supplier photograph',credit:'Photo used with permission',caption:'Licensed editorial image, used with permission.'};
    if(a.slug==='cat-companion')return {page_id:a.slug,filename:'hero-'+a.slug+'.png',kind:'ai-generated',sha256:sha('f'),prompt_sha256:sha('1'),generation_model:'gpt-image-2',generation_provider:'openai-images',alt:'Concept illustration of a cat companion',credit:'AI-generated editorial concept illustration; not product photography',caption:'Conceptual artwork only. Not a depiction of any supplier product, factory or certification.'};
    return {page_id:a.slug,filename:'hero-'+a.slug+'.png',kind:'abstract-fallback',sha256:sha('2'),alt:'Abstract editorial artwork',credit:'Original abstract editorial artwork; not product photography',caption:'Conceptual artwork only. Not a depiction of any supplier product, factory or certification.'};
  });
  const mediaReport={schema_version:'1.0.0',plan_sha256:mediaPlan.plan_sha256,images};
  return {compiled,outline,mediaPlan,mediaReport};
}
test('enterprise source pack becomes a private source-bound issue',()=>{
  const issue=compileMagazineIssueFromEnterprise(fixture());
  assert.equal(issue.publicationStatus,'private-review');
  assert.equal(issue.brand,'Example Company');
  assert.deepEqual(issue.spreads.map(s=>s.kind),['cover','contents','story','gallery','notes','notes','sourcing']);
  assert.equal(issue.assets.length,3);
  assert.equal(issue.assets.find(a=>a.id==='supplier-profile').kind,'licensed-photo');
  assert.equal(issue.assets.find(a=>a.id==='cat-companion').kind,'ai-generated');
  assert.equal(issue.assets.find(a=>a.id==='buyer-enquiry-guide').kind,'abstract-fallback');
  assert.ok(issue.spreads.find(s=>s.id==='source-notebook').evidenceRefs.includes('website-1'));
  assert.equal(issue.spreads[1].chapters.length,5);
});
test('empty product catalogue does not invent a gallery',()=>{
  const issue=compileMagazineIssueFromEnterprise(fixture(false));
  assert.ok(!issue.spreads.some(s=>s.kind==='gallery'));
  assert.equal(issue.spreads.length,6);
  assert.equal(issue.spreads[1].chapters.length,4);
});
test('changed source fingerprint rejects a stale outline',()=>{
  const x=fixture();x.compiled.fingerprint=sha('9');
  assert.throws(()=>compileMagazineIssueFromEnterprise(x),/outline is not bound/);
});
test('tampered outline is rejected',()=>{
  const x=fixture();x.outline.chapters[0].purpose='inject';
  assert.throws(()=>compileMagazineIssueFromEnterprise(x),/outline hash mismatch/);
});
test('media plan/report drift is rejected',()=>{
  const x=fixture();x.mediaReport.images[0].filename='unexpected.png';
  assert.throws(()=>compileMagazineIssueFromEnterprise(x),/invalid or duplicate media/);
  const y=fixture();y.mediaPlan.selections[0].grant_sha256=sha('7');
  assert.throws(()=>compileMagazineIssueFromEnterprise(y),/media plan\/report/);
});
test('licensed photo must match rights fingerprints',()=>{
  const x=fixture();x.mediaReport.images[0].grant_sha256=sha('9');
  assert.throws(()=>compileMagazineIssueFromEnterprise(x),/licensed media/);
});
test('AI image requires prompt provenance and visible concept disclosure',()=>{
  const x=fixture();const image=x.mediaReport.images.find(i=>i.kind==='ai-generated');image.prompt_sha256=null;
  assert.throws(()=>compileMagazineIssueFromEnterprise(x),/generated media provenance/);
  const y=fixture();const generated=y.mediaReport.images.find(i=>i.kind==='ai-generated');generated.caption='Real product photography';
  assert.throws(()=>compileMagazineIssueFromEnterprise(y),/generated media provenance/);
});
test('unknown media kinds and missing image hashes fail closed',()=>{
  const x=fixture();x.mediaReport.images[0].kind='supplier-image';
  assert.throws(()=>compileMagazineIssueFromEnterprise(x),/unsupported media kind/);
  const y=fixture();y.mediaReport.images[0].sha256='bad';
  assert.throws(()=>compileMagazineIssueFromEnterprise(y),/invalid or duplicate media/);
});
test('source media bytes must match their SHA-256 before rendering',async()=>{
  const x=fixture();
  const bytesBySlug=new Map();
  for(const image of x.mediaReport.images){
    const bytes=Buffer.from('normalized-image:'+image.page_id);
    image.sha256=hash(bytes);bytesBySlug.set(image.filename,bytes);
  }
  const issue=compileMagazineIssueFromEnterprise(x);
  const root=await mkdtemp(join(tmpdir(),'buyersite-issue-media-'));
  try{
    for(const [filename,bytes] of bytesBySlug) await writeFile(join(root,filename),bytes);
    assert.equal(await assertIssueMediaFiles({issue,articlesDir:root}),true);
    await writeFile(join(root,'hero-supplier-profile.png'),Buffer.from('tampered'));
    await assert.rejects(()=>assertIssueMediaFiles({issue,articlesDir:root}),/bytes do not match/);
  }finally{await rm(root,{recursive:true,force:true});}
});

test('agent may reorder editorial copy but cannot replace a source media descriptor',()=>{
  const issue=compileMagazineIssueFromEnterprise(fixture());
  const registry=structuredClone(issue.assets);
  assert.equal(acceptMagazineProposal({proposal:issue,approvedAssets:registry}).spreads.length,7);
  const changed=structuredClone(issue);
  changed.assets[0].grantSha256=sha('9');
  assert.throws(()=>acceptMagazineProposal({proposal:changed,approvedAssets:registry}),/provenance descriptor/);
});
