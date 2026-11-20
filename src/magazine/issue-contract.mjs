// Versioned magazine issue contract. Agent output is DATA, never executable Astro/HTML.
const ID = /^[a-z][a-z0-9-]{1,79}$/;
const SHA = /^[a-f0-9]{64}$/;
const ASSET_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/;
const KINDS = Object.freeze(['cover','contents','story','craft','gallery','notes','sourcing']);
const allowed = new Set(KINDS);
const fail = (message) => { throw new TypeError('MAGAZINE_ISSUE: ' + message); };
const hasText = (value,max=500) => typeof value==='string' && value.trim().length>0 && value.length<=max;
const safeHttps = value => {
  try { const url=new URL(value); return url.protocol==='https:' && !url.username && !url.password; }
  catch { return false; }
};
function assertAsset(asset, publicationStatus, articleIds) {
  if (!asset || !ID.test(asset.id || '') || !hasText(asset.alt,300) ||
      !hasText(asset.credit,300)) fail('asset requires safe ID, alt and credit');
  if (publicationStatus==='concept-private') {
    if (asset.kind!=='ai-concept' ||
        (asset.caption!==undefined && !hasText(asset.caption,800)) ||
        typeof asset.src!=='string' ||
        !/^\/magazine-concepts\/[a-z0-9-]+\/[a-z0-9-]+\.svg$/.test(asset.src) ||
        !/concept/i.test(asset.credit) || !/not .*photograph/i.test(asset.credit)) {
      fail('concept edition only accepts explicitly disclosed bundled concept artwork');
    }
    return;
  }
  if (!['licensed-photo','ai-generated','abstract-fallback'].includes(asset.kind)) fail('unsupported source media kind');
  if (!hasText(asset.caption,800) || !ID.test(asset.articleId || '') || !articleIds.has(asset.articleId) ||
      asset.filename!=='hero-'+asset.articleId+'.png' || !SHA.test(asset.sha256 || '') ||
      asset.reviewStatus!=='required') fail('source media must bind to an article and pending review');
  if (asset.kind==='licensed-photo') {
    if (!ASSET_ID.test(asset.assetId || '') || !SHA.test(asset.sourceSha256 || '') ||
        !SHA.test(asset.grantSha256 || '') || !SHA.test(asset.rightsSha256 || '')) {
      fail('licensed photo requires current source, grant and rights fingerprints');
    }
  } else if (asset.kind==='ai-generated') {
    if (!SHA.test(asset.promptSha256 || '') || !hasText(asset.generationModel,160) ||
        !hasText(asset.generationProvider,160) || !/AI-generated/i.test(asset.credit) ||
        !/concept/i.test(asset.caption) || !/(?:not a depiction|not .*photograph)/i.test(asset.caption)) {
      fail('generated image requires prompt provenance and concept disclosure');
    }
  } else if (!/concept/i.test(asset.caption) || !/(?:not a depiction|not .*photograph)/i.test(asset.caption)) {
    fail('abstract fallback requires visible concept disclosure');
  }
}
export function assertMagazineIssue(issue) {
  if (!issue || typeof issue!=='object' || Array.isArray(issue)) fail('object required');
  if (issue.schemaVersion!=='1.0.0') fail('unsupported version');
  if (!['concept-private','private-review'].includes(issue.publicationStatus)) fail('public publication is not supported by this renderer');
  if (!ID.test(issue.id || '')) fail('unsafe issue id');
  if (!hasText(issue.brand,90) || !hasText(issue.title,160) || !hasText(issue.deck,600)) fail('missing brand/title/deck');
  if (!Array.isArray(issue.assets) || issue.assets.length<1 || issue.assets.length>40) fail('asset inventory required');

  const sourceArticles=Array.isArray(issue.sourceArticles)?issue.sourceArticles:[];
  const articleIds=new Set();
  for(const article of sourceArticles){
    if(!article || !ID.test(article.id || '') || articleIds.has(article.id) ||
       !hasText(article.title,170) || !hasText(article.deck,600) ||
       !Array.isArray(article.evidenceRefs)) fail('invalid source article inventory');
    articleIds.add(article.id);
  }
  const evidence=Array.isArray(issue.evidence)?issue.evidence:[];
  const evidenceById=new Map();
  for(const item of evidence){
    if(!item || !ID.test(item.id || '') || evidenceById.has(item.id) ||
       !hasText(item.claim,300) || !hasText(item.value,1200) ||
       !hasText(item.status,80) || !hasText(item.permission,100) ||
       !hasText(item.capturedAt,80) || (item.sourceUrl && !safeHttps(item.sourceUrl))) {
      fail('invalid evidence ledger entry');
    }
    evidenceById.set(item.id,item);
  }
  for(const article of sourceArticles){
    if(article.evidenceRefs.some(ref=>!evidenceById.has(ref))) fail('source article references unknown evidence');
  }
  if(issue.publicationStatus==='private-review'){
    if(!SHA.test(issue.sourceFingerprint || '') || !SHA.test(issue.outlineSha256 || '') ||
       !SHA.test(issue.mediaPlanSha256 || '') || !SHA.test(issue.mediaReportSha256 || '') ||
       sourceArticles.length<2 || evidence.length<1) fail('private issue requires source, outline, media and evidence bindings');
  }

  const assets=new Map();
  for(const asset of issue.assets){
    if(assets.has(asset?.id)) fail('duplicate asset ID');
    assertAsset(asset,issue.publicationStatus,articleIds);
    assets.set(asset.id,asset);
  }
  if (!Array.isArray(issue.spreads) || issue.spreads.length<5 || issue.spreads.length>14) fail('5–14 spreads required');
  const ids=new Set();
  for(const spread of issue.spreads){
    if (!spread || !ID.test(spread.id || '') || ids.has(spread.id)) fail('unsafe or duplicate spread ID');
    ids.add(spread.id);
    if (!allowed.has(spread.kind)) fail('unsupported layout: '+spread.kind);
    if (!hasText(spread.title,170) || !hasText(spread.kicker,120) || !hasText(spread.deck,600)) fail('spread title/kicker/deck required');
    if (!Array.isArray(spread.assetIds) || spread.assetIds.length>6 || !spread.assetIds.every(id=>assets.has(id))) fail('missing/unapproved media');
    if (['cover','craft','gallery','sourcing'].includes(spread.kind) && spread.assetIds.length===0) fail('visual spread requires media');
    if (spread.articleId && !articleIds.has(spread.articleId)) fail('spread references unknown source article');
    if (spread.kind==='contents' && (!Array.isArray(spread.chapters) || spread.chapters.length<3)) fail('contents requires chapters');
    if (spread.kind==='notes' && !((Array.isArray(spread.questions)&&spread.questions.length) || (Array.isArray(spread.evidenceRefs)&&spread.evidenceRefs.length))) fail('notes requires questions or evidence references');
    if (spread.evidenceRefs && (!Array.isArray(spread.evidenceRefs) || !spread.evidenceRefs.every(ref=>evidenceById.has(ref)))) fail('spread references unknown evidence');
    if (spread.sections && (!Array.isArray(spread.sections) || spread.sections.length>20 ||
      spread.sections.some(section=>!hasText(section?.heading,180)||!hasText(section?.body,2000)))) fail('invalid editorial sections');
    if (spread.paragraphs && (!Array.isArray(spread.paragraphs) || spread.paragraphs.length>30 ||
      spread.paragraphs.some(paragraph=>!hasText(paragraph,2000)))) fail('invalid editorial paragraphs');
    if (spread.questions && (!Array.isArray(spread.questions) || spread.questions.length>20 ||
      spread.questions.some(q=>!hasText(q?.title,180)||!hasText(q?.body,1200)))) fail('invalid buyer questions');
    if (spread.items && (!Array.isArray(spread.items) || spread.items.length>6 ||
      spread.items.some(item=>!articleIds.has(item?.articleId)||!hasText(item.title,170)))) fail('invalid gallery item references');
  }
  const kinds=issue.spreads.map(s=>s.kind);
  if(kinds[0]!=='cover' || kinds[1]!=='contents' || kinds.at(-1)!=='sourcing') fail('invalid editorial arc');
  if(kinds.filter(x=>x==='cover').length!==1 || kinds.filter(x=>x==='sourcing').length!==1) fail('exactly one cover and closing sourcing spread');
  for(const chapter of issue.spreads[1].chapters){
    if(!chapter || !ids.has(chapter.target) || !hasText(chapter.title,170)) fail('invalid contents target');
  }
  return issue;
}
export const magazineLayouts=KINDS;