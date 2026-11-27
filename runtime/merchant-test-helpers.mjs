import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function d1(sqlite) {
  return {
    prepare(sql) {
      let args = [];
      const statement = {
        bind(...values) { args = values; return statement; },
        async first() { return sqlite.prepare(sql).get(...args) ?? null; },
        async all() { return { success: true, results: sqlite.prepare(sql).all(...args) }; },
        async run() { const result = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
      return statement;
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.all()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
  };
}

export function testDatabase(t, schemas = ['merchant-support.schema.sql'], filename = ':memory:') {
  const sqlite = new DatabaseSync(filename);
  for (const name of schemas) sqlite.exec(readFileSync(new URL(name, import.meta.url), 'utf8').replaceAll('--> statement-breakpoint', ''));
  t.after(() => sqlite.close());
  return { sqlite, DB: d1(sqlite) };
}
