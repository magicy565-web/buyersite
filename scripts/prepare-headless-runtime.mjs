// Optional QA launcher. The browser package lives outside production dependencies.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = process.argv[2];
if (!runtime)
  throw Error('Usage: node scripts/prepare-headless-runtime.mjs /absolute/path/to/qa-runtime');
const require = createRequire(pathToFileURL(join(resolve(runtime), 'package.json')));
const entry = require.resolve('@sparticuz/chromium');
const { default: chromium } = await import(pathToFileURL(entry).href);
const metadata = JSON.parse(await readFile(join(dirname(entry), '..', 'package.json'), 'utf8'));
const executable = await chromium.executablePath();
// Per-test contexts need independent renderer processes. Single-process mode
// can terminate the shared browser when Playwright closes the first context.
const args = chromium.args.filter((arg) => arg !== '--single-process');
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const wrapper = resolve('.generated/qa-runtime/chromium-headless.sh');
await mkdir(dirname(wrapper), { recursive: true, mode: 0o700 });
await writeFile(
  wrapper,
  '#!/bin/sh\nexec ' + [executable, ...args].map(quote).join(' ') + ' "$@"\n',
  { mode: 0o700 },
);
console.log(
  JSON.stringify(
    { executablePath: wrapper, package: metadata.name, packageVersion: metadata.version },
    null,
    2,
  ),
);
