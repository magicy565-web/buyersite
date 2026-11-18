// A bounded keyword lookup over this edition's already-public evidence.
// It copies source facts; it does not call a model, summarize or infer missing terms.
const stopWords = new Set('a an the and or for to of in is are was were what which how much does do can could should would tell me about please with be on at from this that it its i we need want know you your'.split(' '));
const normalize = (value) => value.normalize('NFKC').toLocaleLowerCase('en').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const text = (value, max) => typeof value === 'string' && value.length <= max ? value : null;

function publicRecord(record, config) {
  if (!record || typeof record !== 'object') return null;
  const id = text(record.id, 120);
  const title = text(record.title, 400);
  const claim = text(record.claim, 400);
  const value = text(record.value, 3_000);
  const rawPath = text(record.page_path, 240);
  if (!rawPath || !rawPath.startsWith('/') || rawPath.startsWith('//') || /[?#\\]/.test(rawPath)) return null;
  const path = rawPath.replace(/\/+$/, '') || '/';
  const allowed = new Set((config.allowedPaths ?? []).map((p) => p.replace(/\/+$/, '') || '/'));
  if (!id || !title || !claim || !value || !allowed.has(path)) return null;
  let url;
  try {
    url = new URL(record.source_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname.endsWith('.invalid') || url.hostname === 'localhost') return null;
  } catch { return null; }
  return {
    id, title, claim, value, page_path: path, source_url: url.href,
    status: text(record.status, 80) || 'unverified',
    captured_at: text(record.captured_at, 40) || null,
  };
}

export function searchSourceRecords(query, config) {
  const terms = [...new Set(normalize(query).split(' ').filter((term) => term && !stopWords.has(term)))].slice(0, 30);
  if (!terms.length) return [];
  const records = Array.isArray(config.sourceRecords) ? config.sourceRecords.slice(0, 5_000) : [];
  const seen = new Set();
  return records.flatMap((candidate) => {
    const record = publicRecord(candidate, config);
    if (!record || seen.has(record.id + '|' + record.page_path)) return [];
    seen.add(record.id + '|' + record.page_path);
    const fields = [[normalize(record.claim), 5], [normalize(record.value), 3], [normalize(record.title), 1]];
    let score = 0;
    for (const term of terms) {
      for (const [content, weight] of fields) if (content.split(' ').some((word) => word === term)) score += weight;
    }
    return score > 0 ? [{ record, score }] : [];
  }).sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    .slice(0, 5).map(({ record }) => record);
}
