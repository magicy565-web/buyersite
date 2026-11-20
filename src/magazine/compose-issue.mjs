// A strict, reproducible handoff from an editorial agent to the Astro renderer.
import { createHash } from 'node:crypto';
import { assertMagazineIssue } from './issue-contract.mjs';
const MEDIA_FIELDS = ['id','src','kind','articleId','filename','sha256','sourceSha256','grantSha256',
  'rightsSha256','assetId','promptSha256','generationModel','generationProvider','alt','credit','caption','reviewStatus'];
const pick = asset => Object.fromEntries(MEDIA_FIELDS.filter(key=>asset[key]!==undefined).map(key=>[key,asset[key]]));
export function acceptMagazineProposal({ proposal, approvedAssets, approvedSourceIssue = null }) {
  if (!Array.isArray(approvedAssets)) throw new TypeError('Approved asset inventory required');
  if (!proposal || typeof proposal!=='object') throw new TypeError('Magazine proposal required');
  const registry=new Map();
  for(const asset of approvedAssets){
    if(!asset || registry.has(asset.id)) throw new TypeError('Invalid or duplicate approved media');
    registry.set(asset.id,JSON.stringify(pick(asset)));
  }
  const candidate=structuredClone(proposal);
  if(!Array.isArray(candidate.assets)) throw new TypeError('Missing magazine media inventory');
  // Compare complete descriptors, not only IDs: never let an agent swap the image or its disclosure.
  for(const asset of candidate.assets){
    if(registry.get(asset.id)!==JSON.stringify(pick(asset))) throw new TypeError('Media provenance descriptor is not the approved record');
  }
  if(candidate.publicationStatus==='private-review'){
    if(!approvedSourceIssue) throw new TypeError('Trusted source issue binding required');
    assertMagazineIssue(approvedSourceIssue);
    const immutable=['id','brand','publicationStatus','sourceFingerprint','outlineSha256','mediaPlanSha256','mediaReportSha256'];
    for(const key of immutable){
      if(JSON.stringify(candidate[key])!==JSON.stringify(approvedSourceIssue[key])) {
        throw new TypeError('Source issue binding changed: '+key);
      }
    }
    if(JSON.stringify(candidate.evidence)!==JSON.stringify(approvedSourceIssue.evidence) ||
       JSON.stringify(candidate.sourceArticles)!==JSON.stringify(approvedSourceIssue.sourceArticles)) {
      throw new TypeError('Agent cannot rewrite source evidence or source article records');
    }
  }
  return assertMagazineIssue(candidate);
}
export function issueFingerprint(issue) {
  // Content-address the source plan, not an assistant narrative or mutable build timestamp.
  return createHash('sha256').update(JSON.stringify(assertMagazineIssue(issue))).digest('hex');
}