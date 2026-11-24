import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export const merchantSchema = readFileSync(new URL('../merchant-knowledge.schema.sql', import.meta.url), 'utf8');

// Execute the real SQLite statements used by D1. This adapter is test-only and
// does not substitute an in-memory repository for production persistence.
export function merchantTestDatabase(path = ':memory:') {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(merchantSchema);
  const statement = (sql, values = []) => ({
    sql, values,
    bind(...bound) { return statement(sql, bound); },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return { results: sqlite.prepare(sql).all(...values) }; },
    async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: result.changes } }; },
  });
  return {
    sqlite,
    prepare: statement,
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(item => {
          const result = sqlite.prepare(item.sql).run(...item.values);
          return { success: true, meta: { changes: result.changes } };
        });
        sqlite.exec('COMMIT');
        return results;
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    close() { sqlite.close(); },
  };
}

export const merchantFixture = Object.freeze({
  merchantId: 'merchant-one', siteSlug: 'edition-one', name: 'Example Merchant',
  origin: 'https://merchant.example', privacyUrl: 'https://merchant.example/privacy', authorizationRef: 'grant:merchant-one:2026-11',
});
export const fixtureNow = '2026-11-24T01:00:00.000Z';
export const approvedFact = (overrides = {}) => ({
  evidence_id: 'fabric-composition', merchant_id: 'merchant-one', kind: 'product',
  claim: 'Fabric composition', value: '100% wool', source_url: 'https://merchant.example/fabric#specification',
  status: 'merchant-confirmed', captured_at: '2026-11-20T00:00:00.000Z', valid_until: null,
  audience: 'public', publication_permission: 'approved', ...overrides,
});
