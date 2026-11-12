export interface EvidenceItem {
  evidence_id: string;
  claim: string;
  value: string;
  source_url: string;
  status: string;
  publication_permission: string;
}
export function resolveEvidence(refs: string[], evidence: EvidenceItem[]): EvidenceItem[] {
  return refs.map((id) => {
    const item = evidence.find((record) => record.evidence_id === id);
    if (!item) throw new Error('Missing evidence: ' + id);
    return item;
  });
}
