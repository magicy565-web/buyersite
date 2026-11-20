export declare const LAYOUT_SCHEMA_VERSION: string;
export declare const DESIGN_FAMILIES: readonly string[];
export declare const COVER_LAYOUTS: readonly string[];
export declare const HOME_BLOCKS: readonly string[];
export declare const HERO_LAYOUTS: readonly string[];
export declare const LEDGER_VARIANTS: readonly string[];
export interface LayoutInputs {
  pages: { page_id: string; page_type: string; evidence_refs?: string[] }[];
  evidence: { evidence_id: string; value: string }[];
  media: { page_id: string; kind: string; review_decision?: string }[];
  siteName: string;
  direction: string;
}
export declare function layoutSignals(input: Partial<LayoutInputs>): Record<string, number | string>;
export declare function planEditionLayout(input: Partial<LayoutInputs>): unknown;
export declare function validateLayoutPlan(plan: unknown, pageIds?: string[]): unknown;
export declare function layoutInputsFromPack(pack: {
  pages: { page_id: string; page_type: string; evidence_refs?: string[] }[];
  evidence: { evidence_id: string; value: string }[];
  mediaReport?: { images?: { page_id: string; kind: string; review_decision?: string }[] };
  site?: { name?: string; designDirection?: string };
  visualPlan?: { direction?: string };
}): LayoutInputs;
