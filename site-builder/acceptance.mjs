import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { writeSitePreview } from './build.mjs';

if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Acceptance requires Node 24.');
const args = process.argv.slice(2);
const staticOnly = args.includes('--static-only');
if (args.some((arg) => arg.startsWith('--') && arg !== '--static-only'))
  throw Error('Unknown acceptance option');
const inputs = args.filter((arg) => !arg.startsWith('--'));
if (!inputs.length)
  inputs.push(
    ...['enterprise.synthetic.json', 'enterprise.edge-cases.json', 'enterprise.empty.json'].map(
      (name) => 'site-builder/fixtures/' + name,
    ),
  );
const started = new Date().toISOString();
const root = resolve('.generated/acceptance', started.replace(/[:.]/g, '-'));
await mkdir(root, { recursive: true });
const git = (...params) => {
  try {
    return execFileSync('git', params, { encoding: 'utf8' }).trim();
  } catch {
    return 'UNKNOWN';
  }
};
const report = {
  version: '1.0.0',
  started_at: started,
  finished_at: null,
  source_commit: git('rev-parse', 'HEAD'),
  source_dirty: git('status', '--porcelain') !== '',
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
    chromium_executable:
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || 'Playwright managed Chromium',
  },
  scope:
    'Builder acceptance only. Default inputs are synthetic fixtures, never live enterprise acceptance.',
  production_deployed: false,
  live_enterprise_ingestion: 'NOT_TESTED',
  status: 'RUNNING',
  unit_tests: 'NOT_TESTED',
  editions: [],
};
const persist = () => writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const run = async (script, env, folder) => {
  const log = join(folder, script.replaceAll(':', '-') + '.log');
  const chunks = [];
  const begin = Date.now();
  const code = await new Promise((done, reject) => {
    const child = spawn('pnpm', [script], { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => done(exitCode));
  });
  await writeFile(log, Buffer.concat(chunks));
  console.log(script + ': ' + (code === 0 ? 'PASS' : 'FAIL') + ' (' + (Date.now() - begin) + 'ms)');
  return {
    status: code === 0 ? 'PASS' : 'FAIL',
    exit_code: code,
    log,
    duration_ms: Date.now() - begin,
  };
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  report.unit_tests = await run('test:site-builder', process.env, root);
  if (report.unit_tests.status !== 'PASS') throw Error('Builder unit tests failed');
  for (const inputFile of inputs) {
    const input = JSON.parse(await readFile(inputFile, 'utf8'));
    const pack = await writeSitePreview(input);
    const folder = join(root, pack.site_slug);
    await mkdir(folder, { recursive: true });
    const entry = {
      input: inputFile,
      input_sha256: hash(await readFile(inputFile)),
      pack,
      check: 'NOT_TESTED',
      build: 'NOT_TESTED',
      output: 'NOT_TESTED',
      browser: 'NOT_TESTED',
      artifact: null,
    };
    report.editions.push(entry);
    await persist();
    const env = { ...process.env, BUYERSITE_BUILD_ROOT: pack.root, ASTRO_TELEMETRY_DISABLED: '1' };
    // These share Astro's content cache and dist. Deliberately run sequentially.
    for (const [key, script] of [
      ['check', 'check'],
      ['build', 'build'],
      ['output', 'verify:output'],
    ]) {
      entry[key] = await run(script, env, folder);
      await persist();
      if (entry[key].status !== 'PASS') throw Error(pack.site_slug + ': ' + script + ' failed');
    }
    const artifactDir = join(folder, 'dist');
    await cp('dist', artifactDir, { recursive: true, errorOnExist: true, force: false });
    const fileHashes = [];
    for (const path of (await readdir(artifactDir, { recursive: true })).map(String).sort()) {
      const bytes = await readFile(join(artifactDir, path)).catch((error) => {
        if (error.code === 'EISDIR') return null;
        throw error;
      });
      if (bytes)
        fileHashes.push({
          path: path.replaceAll('\\', '/'),
          bytes: bytes.length,
          sha256: hash(bytes),
        });
    }
    const canonicalInventory = JSON.stringify(fileHashes);
    entry.artifact = {
      directory: artifactDir,
      inventory_sha256: hash(canonicalInventory),
      files: fileHashes.length,
    };
    await writeFile(
      join(folder, 'artifact-files.json'),
      JSON.stringify(fileHashes, null, 2) + '\n',
    );
    if (!staticOnly) {
      entry.browser = await run(
        'test:browser',
        { ...env, BUYERSITE_BROWSER_REPORT: join(folder, 'browser.json') },
        folder,
      );
      await cp('test-results', join(folder, 'browser-results'), { recursive: true }).catch(
        (error) => {
          if (error.code !== 'ENOENT') throw error;
        },
      );
      await persist();
      if (entry.browser.status !== 'PASS')
        throw Error(pack.site_slug + ': browser acceptance failed; inspect retained log');
    }
    console.log(pack.site_slug + ': artifact inventory SHA256 ' + entry.artifact.inventory_sha256);
  }
  report.status = staticOnly ? 'STATIC_PASS_BROWSER_NOT_TESTED' : 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error = error.message;
  process.exitCode = 1;
} finally {
  report.finished_at = new Date().toISOString();
  await persist();
  console.log('Acceptance: ' + report.status + '\nReport: ' + join(root, 'report.json'));
}
