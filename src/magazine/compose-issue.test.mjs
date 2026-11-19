import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptMagazineProposal, issueFingerprint } from './compose-issue.mjs';
import issue from '../data/magazine-issues/chongker-concept.json' with { type: 'json' };
const copy=()=>structuredClone(issue);
test('approved plan accepted and SHA-256 is stable',()=>{
 const a=copy(),approved=structuredClone(a.assets);
 const accepted=acceptMagazineProposal({proposal:a,approvedAssets:approved});
 assert.equal(accepted.spreads.length,7);
 assert.match(issueFingerprint(accepted),/^[0-9a-f]{64}$/);
 assert.equal(issueFingerprint(accepted),issueFingerprint(copy()));
});
test('asset ID reuse cannot swap image or credit',()=>{
 const a=copy(),registry=structuredClone(a.assets);
 a.assets[0].src='/magazine-concepts/chongker/dog.svg';
 assert.throws(()=>acceptMagazineProposal({proposal:a,approvedAssets:registry}),/provenance descriptor/);
 const b=copy();b.assets[0].credit='A real product photo';
 assert.throws(()=>acceptMagazineProposal({proposal:b,approvedAssets:registry}),/provenance descriptor/);
});
test('changing text changes plan fingerprint',()=>{
 const a=copy(),b=copy();b.spreads[2].title='Another story';
 assert.notEqual(issueFingerprint(a),issueFingerprint(b));
});