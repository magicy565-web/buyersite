#!/usr/bin/env node
import { constants } from 'node:fs';
import { lstat, open, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API_PATH = '/api/buyer/admin/merchant-support';
const MAX_INPUT_BYTES = 512_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENTS = new Set(['claim_submitted', 'claim_approved', 'claim_rejected', 'persona_submitted', 'persona_approved', 'persona_rejected', 'agent_preview_passed', 'agent_published', 'agent_unavailable']);
const HELP = `Usage: node scripts/merchant-support.mjs COMMAND [FILE|-] [--out FILE]

Commands:
  status                    Read merchant support status.
  knowledge-save FILE|-     Save an approved public knowledge version.
  knowledge-activate FILE|- Activate a saved version with compare-and-swap.
  claim-pack [--out FILE]    Read the manual Business Hub setup pack.
  claim-evidence FILE|-     Record the owner's evidence with compare-and-swap.
  drain                     Process one durable support job and retention batch.
  reconcile FILE|-          Review an uncertain delivery with immutable evidence.

Required environment:
  BUYERSITE_MERCHANT_ADMIN_ORIGIN  Exact HTTPS BuyerSite origin.
  BUYERSITE_ADMIN_TOKEN           Existing owner token, 32 to 512 characters.

Input is bounded JSON from a regular file or stdin (-), never inline JSON.
The server derives the owner identity and current merchant from its own config.
This command never submits a Business Hub claim or publishes an OpenAI agent.
`;

class CliError extends Error {}
const invalid = message => { throw new CliError(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAllowed = (value, fields) => object(value) && Object.keys(value).every(key => fields.includes(key));

function parseArguments(argv) {
  if (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0])) return { help: true };
  const [command, ...args] = argv;
  if (command === 'status' && args.length === 0) return { command, method: 'GET', path: API_PATH };
  if (command === 'drain' && args.length === 0) return { command, method: 'POST', path: API_PATH + '/drain', emptyBody: true };
  if (command === 'claim-pack' && (args.length === 0 || (args.length === 2 && args[0] === '--out' && args[1] && !args[1].startsWith('-')))) {
    return { command, method: 'GET', path: API_PATH + '/claim-pack', output: args[1] ?? null };
  }
  const paths = { 'knowledge-save': '/knowledge', 'knowledge-activate': '/knowledge/activate', 'claim-evidence': '/claim-evidence', reconcile: '/reconcile' };
  if (Object.hasOwn(paths, command ?? '') && args.length === 1 && args[0] && (args[0] === '-' || !args[0].startsWith('-'))) {
    return { command, method: 'POST', path: API_PATH + paths[command], input: args[0] };
  }
  invalid('Invalid command or arguments. Run with --help for usage.');
}

function configuration(env) {
  const token = env.BUYERSITE_ADMIN_TOKEN;
  if (typeof token !== 'string' || token.length < 32 || token.length > 512 || /[^\x21-\x7e]/.test(token)) invalid('BUYERSITE_ADMIN_TOKEN must contain 32 to 512 visible ASCII characters.');
  const raw = env.BUYERSITE_MERCHANT_ADMIN_ORIGIN;
  if (typeof raw !== 'string' || raw.length > 2_000 || /[\u0000-\u0020\u007f\\]/.test(raw)) invalid('BUYERSITE_MERCHANT_ADMIN_ORIGIN must be an exact HTTPS origin.');
  let url;
  try { url = new URL(raw); } catch { invalid('BUYERSITE_MERCHANT_ADMIN_ORIGIN must be an exact HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !url.hostname.includes('.') || url.hostname.endsWith('.') || /^(?:\d+\.){3}\d+$/.test(url.hostname) || url.hostname.startsWith('[') ||
      /(?:^|\.)(?:localhost|local|internal|invalid)$/.test(url.hostname)) invalid('BUYERSITE_MERCHANT_ADMIN_ORIGIN must be an exact public HTTPS origin.');
  return { origin: url.origin, token };
}

async function readInput(path, stdin) {
  let bytes;
  if (path === '-') {
    const chunks = []; let size = 0;
    for await (const chunk of stdin) {
      const next = Buffer.from(chunk);
      size += next.byteLength;
      if (size > MAX_INPUT_BYTES) invalid('JSON input exceeds the 512,000-byte limit.');
      chunks.push(next);
    }
    bytes = Buffer.concat(chunks, size);
  } else {
    let handle;
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.size > MAX_INPUT_BYTES) invalid('Input must be a regular file of at most 512,000 bytes.');
      handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      if (!(await handle.stat()).isFile()) invalid('Input must be a regular JSON file.');
      const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1); let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_INPUT_BYTES) invalid('JSON input exceeds the 512,000-byte limit.');
      bytes = buffer.subarray(0, size);
    } catch (error) {
      if (error instanceof CliError) throw error;
      invalid('Cannot read the input JSON file.');
    } finally { await handle?.close(); }
  }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!object(parsed)) throw Error();
    return parsed;
  } catch { invalid('Input must contain one valid UTF-8 JSON object.'); }
}

function validateBody(command, value) {
  if (command === 'knowledge-save') {
    if (!keysAllowed(value, ['facts', 'source_revision']) || !Array.isArray(value.facts) || value.facts.length < 1 || value.facts.length > 1_000 ||
        value.facts.some(fact => !object(fact)) || (value.source_revision != null && (typeof value.source_revision !== 'string' || value.source_revision.length > 128))) invalid('Knowledge input must contain facts and an optional source_revision.');
  } else if (command === 'knowledge-activate') {
    if (!keysAllowed(value, ['revision', 'expectedRevision']) || !HASH.test(value.revision ?? '') ||
        !(value.expectedRevision === null || HASH.test(value.expectedRevision ?? ''))) invalid('Activation requires revision and expectedRevision (a SHA-256 revision or null).');
  } else if (command === 'claim-evidence') {
    if (!keysAllowed(value, ['expectedRevision', 'event_id', 'kind', 'artifact_ref', 'artifact_sha256', 'observed_at', 'official_url', 'knowledge_revision', 'agent_url']) ||
        !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 || !UUID.test(value.event_id ?? '') || !EVENTS.has(value.kind) ||
        typeof value.artifact_ref !== 'string' || !value.artifact_ref || !HASH.test(value.artifact_sha256 ?? '') ||
        typeof value.observed_at !== 'string' || typeof value.official_url !== 'string') invalid('Claim evidence requires a revision, event ID, supported event, and evidence reference, checksum, timestamp, and official URL.');
  } else if (command === 'reconcile') {
    if (!keysAllowed(value, ['operationId', 'expectedUpdatedAt', 'resolution', 'externalConversationId', 'externalMessageId', 'evidenceRef', 'evidenceHash']) ||
        !UUID.test(value.operationId ?? '') || value.operationId !== value.operationId.toLowerCase() ||
        !Number.isSafeInteger(value.expectedUpdatedAt) || value.expectedUpdatedAt < 0 || !['delivered', 'not_delivered'].includes(value.resolution) ||
        typeof value.evidenceRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(value.evidenceRef) || value.evidenceRef.includes('://') || !HASH.test(value.evidenceHash ?? '') ||
        (value.resolution === 'not_delivered' && (value.externalConversationId !== undefined || value.externalMessageId !== undefined))) invalid('Reconciliation requires a current operation timestamp, a resolution and an opaque evidence reference with its checksum.');
  }
  return value;
}

async function readResponse(response) {
  if (!response || response.redirected || response.status < 200 || response.status >= 300) {
    const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : '';
    invalid(`Merchant support request failed${status}. Inspect the owner service before retrying a write.`);
  }
  if (!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') ?? '')) invalid('Merchant support returned an unexpected response format.');
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) invalid('Merchant support response exceeds the size limit.');
  const reader = response.body?.getReader();
  if (!reader) invalid('Merchant support returned an empty response.');
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); invalid('Merchant support response exceeds the size limit.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try {
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
    if (!object(result)) throw Error();
    return result;
  } catch { invalid('Merchant support returned invalid JSON.'); }
}

function safeOutput(value, token) {
  if (typeof value === 'string') return value.split(token).join('[REDACTED]');
  if (Array.isArray(value)) return value.map(item => safeOutput(item, token));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.split(token).join('[REDACTED]'),
    /(?:authorization|password|secret|token|api[_-]?key)/i.test(key) ? '[REDACTED]' : safeOutput(item, token)]));
  return value;
}

/** No request occurs on import. Writes require an explicit write subcommand. */
export async function runMerchantSupportCli(argv, {
  env = process.env, fetchFn = globalThis.fetch, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr,
} = {}) {
  try {
    const command = parseArguments(argv);
    if (command.help) { stdout.write(HELP); return 0; }
    const { origin, token } = configuration(env);
    const input = command.input ? validateBody(command.command, await readInput(command.input, stdin)) : command.emptyBody ? {} : null;
    let response;
    try {
      response = await fetchFn(origin + command.path, {
        method: command.method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(input ? { 'Content-Type': 'application/json' } : {}) },
        ...(input ? { body: JSON.stringify(input) } : {}),
        redirect: 'error', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(command.command === 'drain' ? 55_000 : 15_000),
      });
    } catch { invalid('Merchant support could not be reached. No automatic retry was attempted; inspect operation state before repeating a write.'); }
    const result = await readResponse(response);
    const output = JSON.stringify(safeOutput(result, token), null, 2) + '\n';
    if (command.output) {
      try { await writeFile(command.output, output, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); }
      catch { invalid('Cannot create the output file. Existing files are never overwritten.'); }
      stdout.write('Claim pack saved.\n');
    } else stdout.write(output);
    return 0;
  } catch (error) {
    stderr.write((error instanceof CliError ? error.message : 'Merchant support command failed. No automatic retry was attempted.') + '\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runMerchantSupportCli(process.argv.slice(2));
}
