import { authorizedOwner } from './gateway.mjs';
import { sanitizeCampaign } from '../src/lib/buyer-journey.mjs';

const EVENT_ROW_LIMIT = 20_000;
const PAGE_ROW_LIMIT = 5_000;

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Robots-Tag': 'noindex, nofollow',
      ...(status === 405 ? { Allow: 'GET' } : {}),
    },
  });
}

const counts = (row = {}) => ({
  total: Number(row.total || 0),
  new: Number(row.new || 0),
  qualified: Number(row.qualified || 0),
  archived: Number(row.archived || 0),
});

function campaignGroups(rows) {
  const grouped = new Map();
  for (const row of rows.slice(0, PAGE_ROW_LIMIT)) {
    let campaign = {};
    // Older rows may predate label validation. Never return unsafe legacy free text.
    try { campaign = sanitizeCampaign(JSON.parse(row.labels || '{}'), { strict: true }); } catch {}
    const key = JSON.stringify(campaign);
    const aggregate = grouped.get(key) ?? { ...campaign, total: 0, new: 0, qualified: 0, archived: 0 };
    for (const [name, value] of Object.entries(counts(row))) aggregate[name] += value;
    grouped.set(key, aggregate);
  }
  return [...grouped.values()].sort((a, b) => b.total - a.total);
}

/** Aggregate-only input for the existing editorial worker; never contains a buyer's brief. */
export async function handleFeedback(request, env, config, { now = new Date() } = {}) {
  try {
    await authorizedOwner(request, env);
    if (request.method !== 'GET') return response({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for editorial feedback.' } }, 405);
    if (!config || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(config.siteSlug)) {
      return response({ error: { code: 'SITE_NOT_CONFIGURED', message: 'This edition is not configured.' } }, 503);
    }
    const params = new URL(request.url).searchParams;
    const rawDays = params.get('days') ?? '30';
    if (!/^[1-9]\d?$/.test(rawDays) || Number(rawDays) > 90 || params.getAll('days').length > 1 || [...params.keys()].some((key) => key !== 'days')) {
      return response({ error: { code: 'INVALID_PERIOD', message: 'Choose a whole number of days between 1 and 90.' } }, 400);
    }
    const days = Number(rawDays);
    const end = new Date(now);
    if (!Number.isFinite(end.getTime())) throw new Error('Invalid server clock');
    const today = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
    const start = new Date(today.getTime() - (days - 1) * 86_400_000);
    const after = new Date(today.getTime() + 86_400_000);
    const startDay = start.toISOString().slice(0, 10);
    const endDay = today.toISOString().slice(0, 10);
    const scope = [config.siteSlug, start.toISOString(), after.toISOString()];
    const sums = `COUNT(*) AS total,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new,
      SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) AS qualified,
      SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived`;
    const enquiryWhere = 'WHERE site_slug = ? AND created_at >= ? AND created_at < ?';
    const queries = [
      env.DB.prepare(`SELECT day, event, path, count FROM buyer_event_daily
        WHERE site_slug = ? AND day >= ? AND day <= ?
        ORDER BY day, event, path LIMIT ?`).bind(config.siteSlug, startDay, endDay, EVENT_ROW_LIMIT + 1),
      env.DB.prepare(`SELECT event, SUM(count) AS count FROM buyer_event_daily
        WHERE site_slug = ? AND day >= ? AND day <= ? GROUP BY event ORDER BY event`).bind(config.siteSlug, startDay, endDay),
      env.DB.prepare(`SELECT ${sums} FROM buyer_enquiries ${enquiryWhere}`).bind(...scope),
      env.DB.prepare(`SELECT substr(created_at, 1, 10) AS day, ${sums} FROM buyer_enquiries ${enquiryWhere}
        GROUP BY day ORDER BY day`).bind(...scope),
      env.DB.prepare(`SELECT page_path AS path, ${sums} FROM buyer_enquiries ${enquiryWhere}
        GROUP BY page_path ORDER BY total DESC, path LIMIT ?`).bind(...scope, PAGE_ROW_LIMIT + 1),
      env.DB.prepare(`SELECT originating_page_path AS path, ${sums} FROM buyer_enquiries ${enquiryWhere}
        GROUP BY originating_page_path ORDER BY total DESC, path LIMIT ?`).bind(...scope, PAGE_ROW_LIMIT + 1),
      env.DB.prepare(`SELECT landing_page_path AS path, ${sums} FROM buyer_enquiries ${enquiryWhere}
        GROUP BY landing_page_path ORDER BY total DESC, path LIMIT ?`).bind(...scope, PAGE_ROW_LIMIT + 1),
      env.DB.prepare(`SELECT attribution_json AS labels, ${sums} FROM buyer_enquiries ${enquiryWhere}
        GROUP BY attribution_json ORDER BY total DESC, labels LIMIT ?`).bind(...scope, PAGE_ROW_LIMIT + 1),
      env.DB.prepare(`SELECT attribution_method AS method, ${sums} FROM buyer_enquiries ${enquiryWhere}
        GROUP BY attribution_method ORDER BY total DESC, method`).bind(...scope),
    ];
    // D1 batch provides a consistent transaction across the aggregate queries.
    const result = await env.DB.batch(queries);
    if (!Array.isArray(result) || result.length !== queries.length || result.some((item) => !Array.isArray(item?.results)) || result[2].results.length !== 1) {
      throw new Error('Invalid aggregate result');
    }
    const eventRows = result[0].results ?? [];
    const pageRows = result[4].results ?? [];
    return response({
      schema_version: 'buyer-feedback-v1',
      site_slug: config.siteSlug,
      generated_at: end.toISOString(),
      period: {
        days, start_date: startDay, end_date: endDay, time_zone: 'UTC',
        start_at: start.toISOString(), end_before: after.toISOString(), includes_partial_day: true,
      },
      events: {
        totals: (result[1].results ?? []).map((row) => ({ event: row.event, count: Number(row.count) })),
        by_day_and_page: eventRows.slice(0, EVENT_ROW_LIMIT).map((row) => ({ day: row.day, event: row.event, path: row.path, count: Number(row.count) })),
        rows_truncated: eventRows.length > EVENT_ROW_LIMIT,
        row_limit: EVENT_ROW_LIMIT,
      },
      enquiries: {
        counts: counts(result[2].results?.[0]),
        by_day: (result[3].results ?? []).map((row) => ({ day: row.day, ...counts(row) })),
        by_page: pageRows.slice(0, PAGE_ROW_LIMIT).map((row) => ({ path: row.path, ...counts(row) })),
        pages_truncated: pageRows.length > PAGE_ROW_LIMIT,
        by_originating_article: result[5].results.slice(0, PAGE_ROW_LIMIT).map((row) => ({ path: row.path, ...counts(row) })),
        originating_articles_truncated: result[5].results.length > PAGE_ROW_LIMIT,
        by_landing_page: result[6].results.slice(0, PAGE_ROW_LIMIT).map((row) => ({ path: row.path, ...counts(row) })),
        landing_pages_truncated: result[6].results.length > PAGE_ROW_LIMIT,
        by_campaign: campaignGroups(result[7].results),
        campaigns_truncated: result[7].results.length > PAGE_ROW_LIMIT,
        by_attribution_method: result[8].results.map((row) => ({ method: ['withheld', 'reported-session', 'reported-campaign'].includes(row.method) ? row.method : null, ...counts(row) })),
      },
      definitions: {
        events: 'Browser-reported action counts, including repeated actions. They are not unique visitor counts and may include automated traffic.',
        enquiries: 'Persisted enquiries created during this period, grouped by their current review status. Client-reported enquiry_submitted events do not determine these totals.',
        page: 'The page on which the enquiry was submitted. Legacy records may contain an article path; this field does not establish the original landing page.',
        originating_article: 'An article selected by the buyer and resolved against the server-owned published catalog. It is brief context, not proof of reading or causal acquisition. Null means no article was linked.',
        attribution: 'Landing paths and bounded campaign labels are browser-reported session context, validated by the server but not independently verified. DNT/GPC or buyer removal withholds visit context. Null or empty labels mean unavailable or withheld; unsafe legacy labels are suppressed.',
        qualified: 'Marked qualified by the owner. This is not proof of a supplier quote, message, order or sale.',
        scope: 'Counts describe this site and date window only. Empty counts do not establish demand absence.',
      },
    });
  } catch (error) {
    if (error?.status === 401) return response({ error: { code: 'OWNER_AUTH_REQUIRED', message: 'Owner authentication is required.' } }, 401);
    return response({ error: { code: 'FEEDBACK_UNAVAILABLE', message: 'Editorial feedback is temporarily unavailable.' } }, 503);
  }
}
