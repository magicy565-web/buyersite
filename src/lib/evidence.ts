import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pilot from '../data/evidence.json';

export interface EvidenceItem {
  evidence_id: string;
  claim: string;
  value: string;
  source_url: string | null;
  source_quote?: string | null;
  status: string;
  captured_at?: string;
  publication_permission: string;
}
export function loadEvidence(): EvidenceItem[] {
  const edition = process.env.BUYERSITE_BUILD_ROOT;
  if (!edition) return pilot;
  return JSON.parse(readFileSync(resolve(edition, 'evidence.json'), 'utf8')) as EvidenceItem[];
}
export function resolveEvidence(refs: string[], evidence: EvidenceItem[]): EvidenceItem[] {
  return refs.map((id) => {
    const item = evidence.find((record) => record.evidence_id === id);
    if (!item) throw new Error('Missing evidence: ' + id);
    return item;
  });
}
