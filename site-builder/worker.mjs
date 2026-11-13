import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSiteFromStudio } from './from-enterprise.mjs';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const ENTERPRISE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:@+-]{0,199}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{40,100}$/;
const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
]);
const PRIVATE_HEADERS = {
  'cache-control': 'private, no-store, max-age=0',
  'content-security-policy':
    "default-src 'self'; base-uri 'none'; connect-src 'none'; font-src 'self'; form-action 'none'; frame-ancestors 'self'; img-src 'self' data:; object-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
};

export class WorkerError extends Error {
  constructor(code, status = 400, message = code) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const fail = (code, status, message) => {
  throw new WorkerError(code, status, message);
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (response, status, body) => {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    ...PRIVATE_HEADERS,
    'content-length': String(bytes.length),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(bytes);
};
const constantEqual = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
};

async function atomicJson(path, value) {
  const temporary = path + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function bodyJson(request, maximum = 3_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) fail('REQUEST_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    fail('INVALID_JSON', 400);
  }
}

function validateRequest(input, enterpriseId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_REQUEST', 422);
  if (Object.keys(input).some((key) => !['job', 'sourceBytesBase64'].includes(key)))
    fail('INVALID_REQUEST', 422);
  const job = input.job;
  if (
    !job ||
    typeof job !== 'object' ||
    !JOB_ID.test(job.id || '') ||
    !ENTERPRISE_ID.test(job.enterpriseId || '') ||
    job.enterpriseId !== enterpriseId ||
    job.outputKind !== 'site' ||
    !SHA256.test(job.sourceHash || '')
  ) {
    fail('SITE_JOB_BINDING_REQUIRED', 422);
  }
  if (typeof input.sourceBytesBase64 !== 'string' || input.sourceBytesBase64.length > 2_700_000)
    fail('SOURCE_BYTES_REQUIRED', 422);
  const sourceBytes = Buffer.from(input.sourceBytesBase64, 'base64');
  if (
    !sourceBytes.length ||
    sourceBytes.length > 2_000_000 ||
    sourceBytes.toString('base64') !== input.sourceBytesBase64
  )
    fail('SOURCE_BYTES_REQUIRED', 422);
  if (sha256(sourceBytes) !== job.sourceHash) fail('STUDIO_SOURCE_CHANGED', 409);
  return { job: structuredClone(job), sourceBytes };
}

function publicJob(record) {
  return {
    id: record.id,
    enterpriseId: record.enterpriseId,
    outputKind: 'site',
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sourceHash: record.sourceHash,
    revision: record.revision ?? null,
    artifactHash: record.artifactHash ?? null,
    previewPath: record.state === 'READY' ? `/api/magazines/site-jobs/${record.id}/preview/` : null,
    sourceBinding: record.sourceBinding ?? null,
    error: record.error ?? null,
    publication: 'BLOCKED',
  };
}

function safePreviewPath(raw) {
  let decoded;
  try {
    decoded = decodeURIComponent(raw || '');
  } catch {
    fail('PREVIEW_PATH_INVALID', 400);
  }
  if (decoded.includes('\0') || decoded.includes('\\')) fail('PREVIEW_PATH_INVALID', 400);
  const parts = decoded.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) fail('PREVIEW_PATH_INVALID', 400);
  if (!parts.length || decoded.endsWith('/')) parts.push('index.html');
  return parts.join('/');
}

async function inventory(root) {
  const rows = [];
  for (const item of (await readdir(root, { recursive: true, withFileTypes: true })).sort(
    (a, b) => a.parentPath.localeCompare(b.parentPath) || a.name.localeCompare(b.name),
  )) {
    const path = join(item.parentPath, item.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) fail('ARTIFACT_SYMLINK_FORBIDDEN', 500);
    if (!info.isFile()) continue;
    const name = relative(root, path).split(sep).join('/');
    const bytes = await readFile(path);
    rows.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
  }
  if (!rows.some((row) => row.path === 'index.html')) fail('ARTIFACT_INDEX_MISSING', 500);
  const digest = sha256(Buffer.from(JSON.stringify(rows)));
  return { digest, rows };
}

async function run(command, args, options, logPath) {
  const chunks = [];
  const code = await new Promise((done, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => chunks.push(chunk));
    child.once('error', reject);
    child.once('close', done);
  });
  const output = Buffer.concat(chunks);
  await writeFile(logPath, output, { mode: 0o600 });
  if (code !== 0) fail('BUILD_STEP_FAILED', 500, `${args.join(' ')} exited ${code}`);
  if (output.includes('contains multiple entries with the same slug'))
    fail('BUILD_CONTENT_COLLISION', 500, 'Astro detected content from more than one edition');
}

export async function buildStudioSite({
  job,
  sourceBytes,
  jobDir,
  projectRoot = PROJECT_ROOT,
  capture,
}) {
  const sourceDir = join(jobDir, 'source-pack');
  const built = await createSiteFromStudio(job, sourceBytes, {
    outputBase: sourceDir,
    ...(capture ? { capture } : {}),
  });
  const environment = {
    ...process.env,
    ASTRO_TELEMETRY_DISABLED: '1',
    BUYERSITE_BUILD_ROOT: built.root,
    SITE_URL: 'https://private-preview.invalid',
  };
  const logs = join(jobDir, 'logs');
  await mkdir(logs, { recursive: true, mode: 0o700 });
  // Astro's single-file content store does not include an environment-selected
  // loader base in its configuration digest. Remove that generated index before
  // every serialized job so a previous enterprise cannot remain in the next job.
  await rm(join(projectRoot, 'node_modules', '.astro', 'data-store.json'), { force: true });
  for (const [name, script] of [
    ['check.log', 'check'],
    ['build.log', 'build'],
    ['verify-output.log', 'verify:output'],
  ]) {
    await run('pnpm', [script], { cwd: projectRoot, env: environment }, join(logs, name));
  }
  const staged = join(jobDir, `artifact-staged-${process.pid}-${Date.now()}`);
  await cp(join(projectRoot, 'dist'), staged, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  await chmod(staged, 0o700);
  const manifest = await inventory(staged);
  const revision = 'site_' + manifest.digest.slice(0, 24);
  const artifactDir = join(jobDir, 'revisions', revision);
  await mkdir(dirname(artifactDir), { recursive: true, mode: 0o700 });
  const existing = await stat(artifactDir).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || (await inventory(artifactDir)).digest !== manifest.digest)
      fail('ARTIFACT_REVISION_CONFLICT', 500);
  } else {
    await rename(staged, artifactDir);
  }
  await atomicJson(join(jobDir, 'artifact-manifest.json'), {
    schemaVersion: 'buyer-site-artifact/v1',
    jobId: job.id,
    enterpriseId: job.enterpriseId,
    revision,
    artifactHash: manifest.digest,
    files: manifest.rows,
    previewOnly: true,
    publication: 'BLOCKED',
  });
  return {
    artifactDir,
    artifactHash: manifest.digest,
    files: manifest.rows,
    fingerprint: built.fingerprint,
    revision,
    sourceBinding: built.source_binding,
  };
}

export async function createBuyerSiteWorker({
  bridgeToken,
  dataDir,
  buildJob = buildStudioSite,
  projectRoot = PROJECT_ROOT,
  clock = () => new Date().toISOString(),
} = {}) {
  if (!TOKEN.test(bridgeToken || '')) fail('BRIDGE_TOKEN_INVALID', 500);
  if (typeof dataDir !== 'string' || !dataDir) fail('DATA_DIR_REQUIRED', 500);
  const root = resolve(dataDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const records = new Map();
  let queue = Promise.resolve();

  const save = async (record) => {
    record.updatedAt = clock();
    await atomicJson(join(root, record.id, 'job.json'), record);
  };
  const perform = (record) => {
    queue = queue.then(async () => {
      if (!['QUEUED', 'BUILDING'].includes(record.state)) return;
      record.state = 'BUILDING';
      record.error = null;
      await save(record);
      try {
        const jobDir = join(root, record.id);
        const sourceBytes = await readFile(join(jobDir, 'source.json'));
        const result = await buildJob({ job: record.job, sourceBytes, jobDir, projectRoot });
        const artifact = await inventory(result.artifactDir);
        if (result.artifactHash && result.artifactHash !== artifact.digest)
          fail('ARTIFACT_HASH_MISMATCH', 500);
        record.state = 'READY';
        record.artifactDir = resolve(result.artifactDir);
        record.artifactHash = artifact.digest;
        record.files = artifact.rows;
        record.revision = result.revision || 'site_' + artifact.digest.slice(0, 24);
        record.sourceBinding = result.sourceBinding ?? null;
        await save(record);
      } catch (error) {
        record.state = 'FAILED';
        record.error = {
          code: error?.code || 'SITE_BUILD_FAILED',
          message: error instanceof Error ? error.message.slice(0, 500) : 'Site build failed',
        };
        await save(record);
      }
    });
  };

  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
    try {
      const record = JSON.parse(await readFile(join(root, entry.name, 'job.json'), 'utf8'));
      if (record.id !== entry.name || !ENTERPRISE_ID.test(record.enterpriseId || '')) continue;
      records.set(record.id, record);
      if (['QUEUED', 'BUILDING'].includes(record.state)) {
        record.state = 'QUEUED';
        perform(record);
      }
    } catch {
      // A corrupt job is not served or overwritten automatically.
    }
  }

  const authorize = (request) => {
    if (!constantEqual(request.headers['x-magazine-bridge'], bridgeToken))
      fail('BRIDGE_UNAUTHORIZED', 401);
    const enterpriseId = String(request.headers['x-enterprise-id'] || '');
    if (!ENTERPRISE_ID.test(enterpriseId)) fail('ENTERPRISE_REQUIRED', 403);
    return enterpriseId;
  };

  const handler = async (request, response) => {
    try {
      const enterpriseId = authorize(request);
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const path = url.pathname;
      if (request.method === 'POST' && path === '/site-jobs') {
        const { job, sourceBytes } = validateRequest(await bodyJson(request), enterpriseId);
        const existing = records.get(job.id);
        if (existing) {
          if (existing.enterpriseId !== enterpriseId) fail('SITE_JOB_NOT_FOUND', 404);
          if (existing.sourceHash !== job.sourceHash) fail('SITE_JOB_CONFLICT', 409);
          if (existing.state === 'FAILED') {
            existing.state = 'QUEUED';
            existing.error = null;
            await save(existing);
            perform(existing);
          }
          return json(response, existing.state === 'READY' ? 200 : 202, publicJob(existing));
        }
        const jobDir = join(root, job.id);
        await mkdir(jobDir, { recursive: false, mode: 0o700 });
        await writeFile(join(jobDir, 'source.json'), sourceBytes, { mode: 0o600 });
        const record = {
          id: job.id,
          enterpriseId,
          outputKind: 'site',
          sourceHash: job.sourceHash,
          state: 'QUEUED',
          createdAt: clock(),
          updatedAt: clock(),
          job,
        };
        records.set(record.id, record);
        await save(record);
        perform(record);
        return json(response, 202, publicJob(record));
      }
      if (request.method === 'GET' && path === '/site-jobs') {
        return json(
          response,
          200,
          [...records.values()]
            .filter((record) => record.enterpriseId === enterpriseId)
            .map(publicJob),
        );
      }
      const match = path.match(/^\/site-jobs\/([a-f0-9-]+)(?:\/(.*))?$/i);
      if (!match || !JOB_ID.test(match[1])) fail('SITE_JOB_NOT_FOUND', 404);
      const record = records.get(match[1]);
      if (!record || record.enterpriseId !== enterpriseId) fail('SITE_JOB_NOT_FOUND', 404);
      if (!match[2] && request.method === 'GET') return json(response, 200, publicJob(record));
      if (!['preview', undefined].includes(match[2]) && !match[2]?.startsWith('preview/'))
        fail('SITE_JOB_NOT_FOUND', 404);
      if (!match[2] || !['GET', 'HEAD'].includes(request.method || ''))
        fail('SITE_JOB_NOT_FOUND', 404);
      if (record.state !== 'READY') fail('PREVIEW_NOT_READY', 409);
      const requested = safePreviewPath(match[2].slice('preview'.length));
      if (!record.files.some((file) => file.path === requested))
        fail('PREVIEW_FILE_NOT_FOUND', 404);
      const artifactRoot = resolve(record.artifactDir);
      const file = resolve(artifactRoot, requested);
      if (!file.startsWith(artifactRoot + sep)) fail('PREVIEW_PATH_INVALID', 400);
      const info = await stat(file);
      if (!info.isFile()) fail('PREVIEW_FILE_NOT_FOUND', 404);
      const expected = record.files.find((item) => item.path === requested);
      const stored = await readFile(file);
      if (stored.length !== expected.bytes || sha256(stored) !== expected.sha256)
        fail('PREVIEW_ARTIFACT_CHANGED', 503);
      const bytes = request.method === 'HEAD' ? Buffer.alloc(0) : stored;
      response.writeHead(200, {
        ...PRIVATE_HEADERS,
        'content-length': String(info.size),
        'content-type': MIME.get(extname(file).toLowerCase()) || 'application/octet-stream',
        etag: `"${expected.sha256}"`,
      });
      response.end(bytes);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      const status = Number(error?.status) || 500;
      return json(response, status, {
        error:
          status >= 500 && !error?.code
            ? 'SITE_WORKER_FAILED'
            : error?.code || 'SITE_WORKER_FAILED',
      });
    }
  };

  return {
    handler,
    records,
    async idle() {
      await queue;
    },
  };
}

export async function startBuyerSiteWorker({
  bridgeToken = process.env.BUYERSITE_BRIDGE_TOKEN,
  dataDir = process.env.BUYERSITE_DATA_DIR,
  host = process.env.BUYERSITE_HOST || '127.0.0.1',
  port = Number(process.env.BUYERSITE_PORT || 4319),
  ...options
} = {}) {
  if (host !== '127.0.0.1') fail('LOOPBACK_BIND_REQUIRED', 500);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) fail('PORT_INVALID', 500);
  const worker = await createBuyerSiteWorker({ bridgeToken, dataDir, ...options });
  const server = createServer(worker.handler);
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, host, done);
  });
  return {
    ...worker,
    server,
    url: `http://${host}:${server.address().port}`,
    close: () =>
      new Promise((done, reject) => server.close((error) => (error ? reject(error) : done()))),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const worker = await startBuyerSiteWorker();
    console.log(`Buyer Site Worker listening on ${worker.url}`);
  } catch (error) {
    console.error(`${error?.code || 'SITE_WORKER_FAILED'}: ${error?.message || error}`);
    process.exitCode = 1;
  }
}
