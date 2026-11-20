import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { assertMagazineIssue } from './issue-contract.mjs';

const SHA=/^[a-f0-9]{64}$/;
const ID=/^[a-z][a-z0-9-]{1,79}$/;
const ASSET_ID=/^[a-z0-9][a-z0-9_-]{0,79}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=message=>{throw new TypeError('MAGAZINE_SOURCE_ADAPTER: '+message);};
const unique=items=>[...new Set(items)];
const plain=(value,max=1600)=>typeof value==='string'?value.trim().slice(0,max):'';

function verifyOutline(outline,sourceFingerprint){
  if(!outline||outline.kind!=='source-bound-magazine-outline'||
     outline.publication_status!=='private-review'||
     outline.source_fingerprint!==sourceFingerprint||
     !Array.isArray(outline.chapters)||!SHA.test(outline.outline_sha256||'')) fail('outline is not bound to this source snapshot');
  const {outline_sha256,...body}=outline;
  if(hash(JSON.stringify(body))!==outline_sha256) fail('outline hash mismatch');
}
function verifyMedia({articles,mediaPlan,mediaReport}){
  if(!Array.isArray(mediaPlan?.selections)||!Array.isArray(mediaReport?.images)||
     !SHA.test(mediaPlan.plan_sha256||'')||
     hash(JSON.stringify(mediaPlan.selections))!==mediaPlan.plan_sha256||
     mediaReport.plan_sha256!==mediaPlan.plan_sha256||
     mediaPlan.selections.length!==articles.length||
     mediaReport.images.length!==articles.length) fail('media plan/report does not match the article set');
  const reportById=new Map();
  for(const media of mediaReport.images){
    if(!media||!ID.test(media.page_id||'')||reportById.has(media.page_id)||
       media.filename!=='hero-'+media.page_id+'.png'||!SHA.test(media.sha256||'')) fail('invalid or duplicate media report entry');
    reportById.set(media.page_id,media);
  }
  const planById=new Map(mediaPlan.selections.map(item=>[item.page_id,item]));
  const assets=[];
  for(const article of articles){
    const media=reportById.get(article.slug),selected=planById.get(article.slug);
    if(!media||!selected) fail('article media binding is missing: '+article.slug);
    const base={id:article.slug,articleId:article.slug,filename:media.filename,sha256:media.sha256,
      kind:media.kind,alt:media.alt,credit:media.credit,caption:media.caption,reviewStatus:'required'};
    if(media.kind==='licensed-photo'){
      if(selected.media_kind!=='licensed-photo'||media.source_sha256!==selected.source_sha256||
         media.grant_sha256!==selected.grant_sha256||media.rights_sha256!==selected.rights_sha256||
         !ASSET_ID.test(media.asset_id||'')||!SHA.test(media.source_sha256||'')||
         !SHA.test(media.grant_sha256||'')||!SHA.test(media.rights_sha256||'')) fail('licensed media does not match the current rights selection');
      assets.push({...base,assetId:media.asset_id,sourceSha256:media.source_sha256,
        grantSha256:media.grant_sha256,rightsSha256:media.rights_sha256});
    }else if(media.kind==='ai-generated'){
      if(selected.media_kind!=='generation-requested'||!SHA.test(media.prompt_sha256||'')||
         !plain(media.generation_model,160)||!plain(media.generation_provider,160)||
         !/AI-generated/i.test(media.credit||'')||!/concept/i.test(media.caption||'')||
         !/(?:not a depiction|not .*photograph)/i.test(media.caption||'')) fail('generated media provenance/disclosure is incomplete');
      assets.push({...base,promptSha256:media.prompt_sha256,generationModel:media.generation_model,
        generationProvider:media.generation_provider});
    }else if(media.kind==='abstract-fallback'){
      if(selected.media_kind!=='generation-requested'||!/concept/i.test(media.caption||'')||
         !/(?:not a depiction|not .*photograph)/i.test(media.caption||'')) fail('abstract fallback disclosure is incomplete');
      assets.push(base);
    }else fail('unsupported media kind: '+media.kind);
  }
  return assets;
}

/**
 * Convert the deterministic enterprise outline into a validated magazine issue.
 * This only creates a PRIVATE draft. Image/page review and publication stay separate.
 */
export function compileMagazineIssueFromEnterprise({compiled,outline,mediaPlan,mediaReport}={}){
  if(!compiled||!SHA.test(compiled.fingerprint||'')||!compiled.site||
     !Array.isArray(compiled.articles)||!Array.isArray(compiled.evidence)) fail('compiled enterprise edition required');
  verifyOutline(outline,compiled.fingerprint);
  const byId=new Map();
  for(const article of compiled.articles){
    if(!article||!ID.test(article.slug||'')||byId.has(article.slug)||
       !Array.isArray(article.refs)||!Array.isArray(article.sections)) fail('invalid source article');
    byId.set(article.slug,article);
  }
  const evidenceById=new Map();
  for(const item of compiled.evidence){
    if(!item||!ID.test(item.evidence_id||'')||evidenceById.has(item.evidence_id)) fail('invalid evidence ledger');
    evidenceById.set(item.evidence_id,item);
  }
  for(const article of compiled.articles){
    if(article.refs.some(ref=>!evidenceById.has(ref))) fail('article references unknown evidence');
  }
  const supplier=compiled.articles.find(a=>a.pageType==='supplier-profile');
  const guide=compiled.articles.find(a=>a.pageType==='buyer-guide');
  const products=compiled.articles.filter(a=>a.pageType==='product-editorial');
  if(!supplier||!guide||products.length>12) fail('supplier profile, guide and bounded product set required');

  const assets=verifyMedia({articles:compiled.articles,mediaPlan,mediaReport});
  const evidence=compiled.evidence.map(item=>({
    id:item.evidence_id,claim:plain(item.claim,300),value:plain(item.value,1200),
    status:plain(item.status,80),permission:plain(item.publication_permission,100),
    sourceUrl:item.source_url||null,capturedAt:plain(item.captured_at,80),
    sourceQuote:plain(item.source_quote,600),notes:plain(item.notes,500),
  }));
  const sourceArticles=compiled.articles.map(article=>({
    id:article.slug,pageType:article.pageType,title:plain(article.title,170),
    deck:plain(article.deck,600),evidenceRefs:unique(article.refs),
  }));
  const spreads=[];
  const outlineChapter=id=>outline.chapters.find(chapter=>chapter.id===id);
  const push=(id,spread)=>{if(!outlineChapter(id)) fail('outline chapter missing: '+id);spreads.push({id,...spread});};
  const brand=plain(compiled.site.name,120).replace(/\s+\|\s+Buyer Notes$/,'').slice(0,90)||'Buyer Edition';
  const sourceNotebookRefs=unique(compiled.evidence.map(item=>item.evidence_id));
  const coverChapter=outlineChapter('cover');
  const coverArticle=byId.get(coverChapter?.article_ids?.[0]);
  if(!coverArticle) fail('cover has no source article');
  push('cover',{kind:'cover',kicker:'BUYER MAGAZINE · PRIVATE PREVIEW',
    title:brand,deck:plain(compiled.site.description,600),assetIds:[coverArticle.slug],
    articleId:coverArticle.slug,evidenceRefs:unique(coverArticle.refs),folio:'01'});
  push('contents',{kind:'contents',kicker:'THE ISSUE',title:'Inside this issue',
    deck:'A source-bound reading path through this enterprise edition.',assetIds:[],evidenceRefs:[],folio:'02–03',
    chapters:[]});

  const storyChapter=outlineChapter('company-story');
  const storyArticle=byId.get(storyChapter?.article_ids?.[0]);
  if(!storyArticle) fail('company story has no source article');
  push('company-story',{kind:'story',kicker:'01 · COMPANY STORY',
    title:plain(storyArticle.title,170),deck:plain(storyArticle.deck,600),
    assetIds:[],articleId:storyArticle.slug,evidenceRefs:unique(storyArticle.refs),
    sections:storyArticle.sections.map(([heading,body])=>({heading:plain(heading,180),body:plain(body,2000)})),folio:'04–05'});

  const portfolio=outlineChapter('product-portfolio');
  if(portfolio){
    const portfolioArticles=portfolio.article_ids.map(id=>byId.get(id));
    if(!portfolioArticles.length||portfolioArticles.some(article=>!article||article.pageType!=='product-editorial')) fail('product portfolio references invalid articles');
    push('product-portfolio',{kind:'gallery',kicker:'02 · SELECTED PRODUCTS',
      title:'Product stories',deck:'Selected product records from the enterprise library.',
      assetIds:portfolioArticles.map(article=>article.slug),
      items:portfolioArticles.map(article=>({articleId:article.slug,title:plain(article.title,170),deck:plain(article.deck,600),evidenceRefs:unique(article.refs)})),
      evidenceRefs:unique(portfolioArticles.flatMap(article=>article.refs)),folio:'06–07'});
  }

  const notebook=outlineChapter('source-notebook');
  if(!notebook) fail('source notebook chapter missing');
  push('source-notebook',{kind:'notes',kicker:'SOURCE NOTEBOOK',
    title:'What we know — and what remains unverified',
    deck:'Claims are attributed to their recorded source and status; this is not an independent supplier audit.',
    assetIds:[],evidenceRefs:sourceNotebookRefs,
    questions:[{title:'Verification status',body:'Supplier-stated information is not independently verified. Confirm technical, legal and commercial details directly before making a sourcing decision.'}],
    folio:portfolio?'08–09':'06–07'});

  const buyerQuestions=outlineChapter('buyer-questions');
  if(!buyerQuestions) fail('buyer questions chapter missing');
  const guideArticle=byId.get(buyerQuestions.article_ids[0]);
  if(!guideArticle) fail('buyer guide article missing');
  push('buyer-questions',{kind:'notes',kicker:'BUYER QUESTIONS',
    title:'Questions to confirm',deck:plain(guideArticle.deck,600),assetIds:[],
    articleId:guideArticle.slug,evidenceRefs:unique(guideArticle.refs),
    questions:guideArticle.sections.map(([title,body])=>({title:plain(title,180),body:plain(body,1200)})),
    folio:portfolio?'10–11':'08–09'});

  const sourcing=outlineChapter('sourcing');
  if(!sourcing) fail('sourcing chapter missing');
  push('sourcing',{kind:'sourcing',kicker:'THE NEXT STEP',
    title:'Prepare a supplier enquiry',deck:'Carry the questions from this edition into a buyer-reviewed brief.',
    assetIds:[guideArticle.slug],articleId:guideArticle.slug,
    evidenceRefs:unique(guideArticle.refs),folio:portfolio?'12':'10'});

  const contents=spreads.find(spread=>spread.id==='contents');
  contents.chapters=spreads.filter(spread=>!['cover','contents'].includes(spread.id)).map((spread,index)=>({
    number:String(index+1).padStart(2,'0'),title:spread.title,target:spread.id,
  }));
  const mediaReportSha256=hash(JSON.stringify(mediaReport));
  const issue={
    schemaVersion:'1.0.0',
    id:(plain(compiled.site.slug,50).toLowerCase().replace(/[^a-z0-9-]/g,'-').replace(/^-+|-+$/g,'').slice(0,48)||'buyer-edition')+'-issue',
    brand,title:plain(compiled.site.name,160),deck:plain(compiled.site.description,600),
    publicationStatus:'private-review',visualProfile:compiled.visualPlan?.direction||'editorial',
    sourceFingerprint:compiled.fingerprint,outlineSha256:outline.outline_sha256,
    mediaPlanSha256:mediaPlan.plan_sha256,mediaReportSha256,
    sourceArticles,evidence,assets,spreads,
  };
  return assertMagazineIssue(issue);
}

/** Bind every source-backed media descriptor to the exact normalized bytes in the private edition pack. */
export async function assertIssueMediaFiles({issue,articlesDir}={}){
  assertMagazineIssue(issue);
  if(typeof articlesDir!=='string'||!isAbsolute(articlesDir)) fail('absolute private article media directory required');
  const root=resolve(articlesDir);
  const rootStat=await lstat(root).catch(()=>null);
  if(!rootStat?.isDirectory()||rootStat.isSymbolicLink()||await realpath(root)!==root) fail('article media directory is not a private regular directory');
  for(const asset of issue.assets){
    if(!asset.articleId) continue; // bundled concept artwork is outside the enterprise media pack
    const file=join(root,asset.filename);
    const info=await lstat(file).catch(()=>null);
    if(!info?.isFile()||info.isSymbolicLink()||info.size>12_000_000||await realpath(file)!==file) fail('unsafe or missing media file: '+asset.filename);
    const bytes=await readFile(file);
    if(hash(bytes)!==asset.sha256) fail('media bytes do not match the issue descriptor: '+asset.articleId);
  }
  return true;
}
