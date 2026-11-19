// Guarded agent-to-renderer handoff. The agent proposes; deterministic code validates.
import { assertMagazineIssue } from './issue-contract.mjs';
export function acceptMagazineProposal({ proposal, approvedAssets }) {
  if (!Array.isArray(approvedAssets)) throw new TypeError('Approved asset inventory required');
  const ids=new Set(approvedAssets.map(asset=>asset.id));
  const candidate=structuredClone(proposal);
  if (!candidate.assets.every(asset=>ids.has(asset.id))) {
    throw new TypeError('Agent referred to media outside the approved inventory');
  }
  // The concept compiler never upgrades an asset to actual supplier evidence.
  for(const asset of candidate.assets) {
    if(asset.kind!=='ai-concept') throw new TypeError('Real photography requires the separate existing media-rights workflow');
  }
  return assertMagazineIssue(candidate);
}
export function issueFingerprint(issue) {
  const canonical=JSON.stringify(assertMagazineIssue(issue));
  // Stable canonical text is the input to the existing site's SHA-256 release pipeline.
  return canonical;
}