// Versioned magazine issue contract. Agent output is DATA, never executable Astro/HTML.
const ID = /^[a-z][a-z0-9-]{1,63}$/;
const KINDS = Object.freeze(['cover','contents','story','craft','gallery','notes','sourcing']);
const allowed = new Set(KINDS);
const fail = (message) => { throw new TypeError('MAGAZINE_ISSUE: ' + message); };
const hasText = (value,max=500) => typeof value==='string' && value.trim().length>0 && value.length<=max;
export function assertMagazineIssue(issue) {
  if (!issue || typeof issue!=='object' || Array.isArray(issue)) fail('object required');
  if (issue.schemaVersion!=='1.0.0') fail('unsupported version');
  if (issue.publicationStatus!=='concept-private') fail('concept-preview only; do not publish');
  if (!ID.test(issue.id)) fail('unsafe issue id');
  if (!hasText(issue.brand,90) || !hasText(issue.title,160) || !hasText(issue.deck,600)) fail('missing brand/title/deck');
  if (!Array.isArray(issue.assets) || issue.assets.length<1 || issue.assets.length>40) fail('asset inventory required');
  const assets=new Map();
  for(const asset of issue.assets){
    if (!asset || !ID.test(asset.id) || assets.has(asset.id)) fail('unsafe or duplicate asset ID');
    if (asset.kind!=='ai-concept') fail('no unlicensed photograph or unsourced media');
    if (typeof asset.src!=='string' || !/^\/magazine-concepts\/[a-z0-9-]+\/[a-z0-9-]+\.svg$/.test(asset.src)) fail('only bundled concept assets allowed');
    if (!hasText(asset.alt,250) || !hasText(asset.credit,200)) fail('asset requires alt and disclosure');
    assets.set(asset.id,asset);
  }
  if (!Array.isArray(issue.spreads) || issue.spreads.length<5 || issue.spreads.length>14) fail('5–14 spreads required');
  const ids=new Set();
  for(const spread of issue.spreads){
    if (!spread || !ID.test(spread.id) || ids.has(spread.id)) fail('unsafe or duplicate spread ID');
    ids.add(spread.id);
    if (!allowed.has(spread.kind)) fail('unsupported layout: '+spread.kind);
    if (!hasText(spread.title,170) || !hasText(spread.kicker,120)) fail('spread title/kicker required');
    if (!Array.isArray(spread.assetIds) || spread.assetIds.length>6 || !spread.assetIds.every(id=>assets.has(id))) fail('missing/unapproved media');
    if (spread.kind!=='notes' && spread.assetIds.length===0) fail('visual spread requires media');
    if (spread.kind==='contents' && (!Array.isArray(spread.chapters) || spread.chapters.length<3)) fail('contents requires chapters');
    if (spread.kind==='notes' && (!Array.isArray(spread.questions) || !spread.questions.length)) fail('buyer questions required');
    for(const paragraph of spread.paragraphs||[]) if (!hasText(paragraph,1500)) fail('invalid editorial paragraph');
  }
  const kinds=issue.spreads.map(s=>s.kind);
  if(kinds[0]!=='cover' || kinds[1]!=='contents' || kinds.at(-1)!=='sourcing') fail('invalid editorial arc');
  if(kinds.filter(x=>x==='cover').length!==1 || kinds.filter(x=>x==='sourcing').length!==1) fail('exactly one cover and closing sourcing spread');
  for(const chapter of issue.spreads[1].chapters){
    if(!chapter || !ids.has(chapter.target) || !hasText(chapter.title,120)) fail('invalid contents target');
  }
  return issue;
}
export const magazineLayouts=KINDS;