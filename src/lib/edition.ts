// Presentation helpers for the v2 magazine blocks. Nothing here creates a fact: every value
// printed comes from evidence.json or the buyer brief, and these functions only decide how
// it is set on the page.
import type { EvidenceItem } from './evidence';

/**
 * Split a source value into a display figure and the rest of the sentence, so a measured value
 * can be set large. `head + tail` is always exactly the original string: the value stays
 * verbatim and contiguous in the page text (scripts/verify-output.mjs checks for it).
 */
export function splitFigure(value: string): { head: string; tail: string; numeric: boolean } {
  const match = /^(\d[\d.,]*(?:\s?(?:%|[A-Za-z]{1,3}(?:\/[A-Za-z]{1,3})?)(?![A-Za-z]))?)([\s\S]*)$/.exec(value);
  if (!match) return { head: value, tail: '', numeric: false };
  return { head: match[1], tail: match[2], numeric: true };
}

/** The latest capture date across the facts on a page or an edition, as YYYY-MM-DD. */
export function latestCapture(items: EvidenceItem[]): string | null {
  const dates = items.map((item) => item.captured_at).filter(Boolean) as string[];
  return dates.length ? dates.sort().at(-1)!.slice(0, 10) : null;
}

export function sourceHost(url?: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export function formatDay(day: string | null, locale = 'en'): string | null {
  if (!day) return null;
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(day + 'T00:00:00Z'),
  );
}

/** What an edition can honestly say about itself, derived from its own records. */
export function editionFacts(evidence: EvidenceItem[]) {
  const sources = new Set(evidence.map((item) => item.source_url).filter(Boolean));
  return {
    facts: evidence.length,
    sources: sources.size,
    supplierStated: evidence.filter((item) => item.status === 'supplier-stated').length,
    verified: evidence.filter((item) => item.verified_by).length,
    latest: latestCapture(evidence),
  };
}
