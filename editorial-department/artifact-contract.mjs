import { createHash } from 'node:crypto';

const SHA=/^[a-f0-9]{64}$/;
const ID=/^[a-z][a-z0-9-]{1,79}$/;
const fail=(message)=>{throw new TypeError('EDITORIAL_ARTIFACT: '+message);};
const text=(value,max=2000)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
const object=value=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);
const unique=values=>Array.isArray(values)&&new Set(values).size===values.length;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const boundedJson=(value,max=256_000)=>{
  let bytes;
  try{bytes=Buffer.byteLength(JSON.stringify(value));}catch{fail('artifact is not JSON serializable');}
  if(bytes>max)fail('artifact exceeds the bounded output size');
};

function sourceRefsFor(article,knownEvidence){
  if(!Array.isArray(article.evidenceRefs)||article.evidenceRefs.length<1||!unique(article.evidenceRefs))fail('every editorial section must cite evidence IDs');
  if(article.evidenceRefs.some(ref=>!knownEvidence.has(ref)))fail('editorial output references unknown evidence');
}

export function assertCompiledEnterprise(compiled){
  if(!object(compiled)||!SHA.test(compiled.fingerprint||'')||!object(compiled.site)||
     !Array.isArray(compiled.articles)||compiled.articles.length<2||compiled.articles.length>14||
     !Array.isArray(compiled.evidence)||compiled.evidence.length<1||compiled.evidence.length>200||
     !Array.isArray(compiled.pages)||!Array.isArray(compiled.publication_blockers))fail('compiled enterprise edition is incomplete');
  const articleIds=new Set(),evidenceIds=new Set();
  for(const item of compiled.evidence){
    if(!object(item)||!ID.test(item.evidence_id||'')||evidenceIds.has(item.evidence_id)||
       !text(item.claim,300)||!text(item.value,1200)||!text(item.status,80)||
       !text(item.publication_permission,100))fail('compiled evidence ledger is invalid');
    evidenceIds.add(item.evidence_id);
  }
  for(const article of compiled.articles){
    if(!object(article)||!ID.test(article.slug||'')||articleIds.has(article.slug)||
       !text(article.title,170)||!text(article.deck,600)||!Array.isArray(article.refs)||(article.pageType!=='buyer-guide'&&article.refs.length<1)||
       article.refs.some(ref=>!evidenceIds.has(ref))||
       !Array.isArray(article.sections)||article.sections.length<1||article.sections.length>20||
       article.sections.some(section=>!Array.isArray(section)||section.length!==2||
         !text(section[0],180)||!text(section[1],2000)))fail('compiled source article is invalid or ungrounded');
    articleIds.add(article.slug);
  }
  if(compiled.articles.some(article=>!compiled.pages.some(page=>page.page_id===article.slug&&
      typeof page.path==='string'&&/^\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(page.path))))fail('compiled article has no canonical route');
  return compiled;
}

export function assertEditorialBrief(brief,compiled){
  assertCompiledEnterprise(compiled);
  if(!object(brief)||!text(brief.audience,240)||!text(brief.buyingIntent,240)||
     !text(brief.angle,600)||!text(brief.title,160)||!text(brief.deck,600)||
     !Array.isArray(brief.evidenceRefs)||brief.evidenceRefs.length<1||
     brief.evidenceRefs.some(ref=>!compiled.evidence.some(item=>item.evidence_id===ref))) {
    fail('editorial brief must name its audience, buying intent, angle and source evidence');
  }
  return brief;
}

export function assertEditorialOutline(outline,compiled){
  assertCompiledEnterprise(compiled);
  assertEditorialBrief(outline?.brief,compiled);
  if(!Array.isArray(outline.chapters)||outline.chapters.length<3||outline.chapters.length>14)fail('issue outline requires 3–14 chapters');
  const ids=new Set();
  for(const chapter of outline.chapters){
    if(!object(chapter)||!ID.test(chapter.id||'')||ids.has(chapter.id)||
       !text(chapter.purpose,500)||!Array.isArray(chapter.articleIds)||
       chapter.articleIds.some(id=>!compiled.articles.some(article=>article.slug===id))||
       !Array.isArray(chapter.evidenceRefs)||chapter.evidenceRefs.length<1||
       chapter.evidenceRefs.some(ref=>!compiled.evidence.some(item=>item.evidence_id===ref)))fail('issue outline chapter is invalid or ungrounded');
    ids.add(chapter.id);
  }
  return outline;
}

export function assertEditorialDraft(draft,compiled){
  assertCompiledEnterprise(compiled);
  if(!object(draft)||draft.schemaVersion!=='editorial-draft/v1'||
     !Array.isArray(draft.articles)||draft.articles.length!==compiled.articles.length||
     !Array.isArray(draft.buyerQuestions)||draft.buyerQuestions.length<1||draft.buyerQuestions.length>12) {
    fail('editorial draft does not cover the frozen source article set');
  }
  const knownEvidence=new Set(compiled.evidence.map(item=>item.evidence_id));
  const sourceById=new Map(compiled.articles.map(article=>[article.slug,article]));
  const seen=new Set();
  for(const article of draft.articles){
    const source=sourceById.get(article?.id);
    if(!source||seen.has(article.id)||!text(article.title,170)||!text(article.deck,600)||
       !Array.isArray(article.sections)||article.sections.length<1||article.sections.length>20)fail('editorial article is invalid or duplicated');
    seen.add(article.id);
    for(const section of article.sections){
      if(!object(section)||!text(section.heading,180)||!text(section.body,2000))fail('editorial section is invalid');
      if(source.pageType==='buyer-guide'&&section.evidenceRefs.length===0){/* generic buyer guidance may be source-neutral */}
      else sourceRefsFor(section,knownEvidence);
      if(section.evidenceRefs.some(ref=>!source.refs.includes(ref)))fail('editorial section cannot cite evidence outside its source article');
    }
  }
  for(const question of draft.buyerQuestions){
    if(!object(question)||!text(question.title,180)||!text(question.body,1200))fail('buyer question is invalid');
    sourceRefsFor(question,knownEvidence);
  }
  boundedJson(draft,180_000);
  return draft;
}

export function applyEditorialDraft(compiled,draft){
  assertEditorialDraft(draft,compiled);
  const byId=new Map(draft.articles.map(article=>[article.id,article]));
  const articles=compiled.articles.map(source=>{
    const copy=byId.get(source.slug);
    return {...source,title:copy.title,deck:copy.deck,
      sections:copy.sections.map(section=>[section.heading,section.body])};
  });
  const editorialDraftSha256=hash(draft);
  const fingerprint=createHash('sha256')
    .update(JSON.stringify({sourceFingerprint:compiled.fingerprint,editorialDraftSha256}))
    .digest('hex');
  return {...compiled,articles,fingerprint,editorialDraftSha256};
}

export function assertArtDirection(direction,compiled){
  assertCompiledEnterprise(compiled);
  if(!object(direction)||direction.schemaVersion!=='art-direction/v1'||
     !text(direction.visualDNA,1200)||/https?:\/\/|data:|file:|<\/?(?:script|svg)|\b(?:actual|real) supplier product\b|\bphotograph of (?:a )?(?:product|factory)\b|\bfactory interior\b|\bcertification seal\b/i.test(direction.visualDNA)||!Array.isArray(direction.spreads)||
     direction.spreads.length<3||direction.spreads.length>14)fail('art direction must provide a bounded visual DNA and spread plan');
  const sourceIds=new Set(compiled.articles.map(article=>article.slug));
  const seen=new Set();
  for(const spread of direction.spreads){
    if(!object(spread)||!ID.test(spread.id||'')||seen.has(spread.id)||
       !text(spread.desktopComposition,600)||!text(spread.mobileComposition,600)||
       !Array.isArray(spread.articleIds)||spread.articleIds.some(id=>!sourceIds.has(id)))fail('responsive spread direction is invalid');
    seen.add(spread.id);
  }
  boundedJson(direction,80_000);
  return direction;
}

const REVIEW_STATUSES=new Set(['PASS_RECOMMENDED','REVISION_REQUIRED','PENDING_CONFIGURATION','REVIEW_ERROR']);
export function assertReviewArtifact(review){
  if(!object(review)||!REVIEW_STATUSES.has(review.status)||
     !Array.isArray(review.findings)||review.findings.length>80||
     review.findings.some(item=>!object(item)||!['critical','major','minor','info'].includes(item.severity)||
       !text(item.message,1000)))fail('review artifact is invalid');
  if(review.status==='PASS_RECOMMENDED'&&review.findings.some(item=>item.severity==='critical'))fail('a critical finding cannot pass review');
  return review;
}

export function validateTaskArtifact(taskId,artifact,context={}){
  if(!object(artifact))fail('task artifact must be an object');
  boundedJson(artifact,300_000);
  switch(taskId){
    case 'capture-source':{
      const page=artifact.snapshot;
      if(!object(page)||page.url!==context.websiteUrl||!text(page.title,300)||
         !text(page.captured_at,80)||!text(page.body_text,30_000)||
         !SHA.test(page.content_sha256||'')||
         createHash('sha256').update(page.body_text).digest('hex')!==page.content_sha256)fail('source capture does not match the authorized URL and content hash');
      return artifact;
    }
    case 'compile-enterprise':
      assertCompiledEnterprise(artifact.compiled);
      if(!object(artifact.outline)||artifact.outline.kind!=='source-bound-magazine-outline'||
         artifact.outline.source_fingerprint!==artifact.compiled.fingerprint||
         !SHA.test(artifact.outline.outline_sha256||''))fail('compiled issue outline is not source-bound');
      return artifact;
    case 'editorial-outline':
      assertEditorialOutline(artifact,context.compiled);
      return artifact;
    case 'draft-editorial-copy':
      assertEditorialDraft(artifact,context.compiled);
      return artifact;
    case 'art-direction':
      assertArtDirection(artifact,context.compiled);
      return artifact;
    case 'skip-product-gallery':
      if(artifact.status!=='SKIPPED'||artifact.selectedProductCount!==0||
         artifact.reason!=='NO_SELECTED_PRODUCTS')fail('no-gallery confirmation is invalid');
      return artifact;
    case 'prepare-media':
      if(!SHA.test(artifact.planSha256||'')||!SHA.test(artifact.reportSha256||'')||
         !Array.isArray(artifact.images)||artifact.images.length<1||artifact.images.length>14||
         artifact.images.some(item=>!object(item)||!ID.test(item.pageId||'')||
           !['licensed-photo','ai-generated','abstract-fallback'].includes(item.kind)||
           !SHA.test(item.sha256||'')||!text(item.credit,300)))fail('media receipt is invalid');
      return artifact;
    case 'compile-issue':
      if(!object(artifact.issue)||artifact.issue.schemaVersion!=='1.0.0'||
         !SHA.test(artifact.issueSha256||'')||hash(artifact.issue)!==artifact.issueSha256||
         !Number.isInteger(artifact.spreadCount)||artifact.spreadCount<5||artifact.spreadCount>14)fail('compiled IssueSpec receipt is invalid');
      return artifact;
    case 'build-private-preview':
      if(artifact.previewOnly!==true||artifact.publication!=='BLOCKED'||
         !SHA.test(artifact.artifactSha256||'')||!text(artifact.revision,120)||
         !text(artifact.previewPath,500))fail('private preview receipt is invalid');
      return artifact;
    case 'review-content':
    case 'review-media':
    case 'review-visuals':
      return assertReviewArtifact(artifact);
    case 'prepare-distribution': {
      if(artifact.schemaVersion!=='distribution-draft/v1'||!Array.isArray(artifact.items)||
         artifact.items.length<1||artifact.items.length>12)fail('distribution draft must contain 1–12 reviewed items');
      for(const item of artifact.items) {
        if(!object(item)||!['search','reddit','linkedin','tiktok','newsletter'].includes(item.channel)||
           !text(item.title,180)||!text(item.copy,2000)||
           typeof item.canonicalPath!=='string'||!/^\/[a-z0-9-]+\/[a-z0-9-]+\/$/.test(item.canonicalPath)||
           item.publish!==false)fail('distribution draft must be channel-specific, canonical and explicitly unpublished');
      }
      boundedJson(artifact,60_000);
      return artifact;
    }
    case 'verify-output':
      if(artifact.status!=='PASS'||artifact.publication!=='BLOCKED'||
         !SHA.test(artifact.artifactSha256||'')||!Number.isInteger(artifact.fileCount)||
         artifact.fileCount<1||artifact.previewOnly!==true)fail('output verification receipt is invalid');
      return artifact;
    default:
      fail('task has no model-submittable artifact contract: '+taskId);
  }
}
