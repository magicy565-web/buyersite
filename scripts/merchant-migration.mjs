import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SOURCES = ['merchant-knowledge.schema.sql', 'merchant-support.schema.sql', 'merchant-agentbot.schema.sql', 'merchant-reconciliation.schema.sql'];
const TARGET = new URL('../drizzle/0006_merchant_support.sql', import.meta.url);

export async function merchantMigration() {
  const statements = [];
  for (const source of SOURCES) {
    const text = await readFile(new URL('../runtime/' + source, import.meta.url), 'utf8');
    let block = ''; let trigger = false;
    for (const line of text.split('\n')) {
      block += line + '\n';
      if (/^CREATE TRIGGER\b/.test(line)) trigger = true;
      if (line.trimEnd().endsWith(';') && (!trigger || /^END;\s*$/.test(line))) {
        statements.push(block.trim()); block = ''; trigger = false;
      }
    }
    if (block.trim() && !block.trim().startsWith('--')) throw Error('Incomplete merchant migration source: ' + source);
  }
  return '-- Generated from runtime/merchant-*.schema.sql by pnpm merchant:migration.\n' + statements.join('\n--> statement-breakpoint\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sql = await merchantMigration();
  if (process.argv.includes('--check')) {
    if (await readFile(TARGET, 'utf8') !== sql) throw Error('MERCHANT_MIGRATION_STALE: run pnpm merchant:migration.');
    console.log('Merchant migration matches its reviewed schema fragments.');
  } else { await writeFile(TARGET, sql); console.log('Wrote drizzle/0006_merchant_support.sql.'); }
}
