import { open, mkdir, writeFile } from 'node:fs/promises';
import { dirname, basename, resolve } from 'node:path';
import { collectSources, LIMITS } from './index.mjs';

async function boundedFile(path, limit) {
  const handle = await open(path, 'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Only regular files may be collected');
    const result = Buffer.alloc(limit + 1);
    let offset = 0;
    while (offset < result.length) {
      const { bytesRead } = await handle.read(result, offset, result.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit) throw new Error('File exceeds collection limit');
    return result.subarray(0, offset);
  } finally { await handle.close(); }
}

try {
  const [manifest, destination] = process.argv.slice(2);
  if (!manifest || !destination || process.argv.length !== 4)
    throw new Error('Usage: node collection/cli.mjs request.json .generated/collection/bundle.json');
  const input = JSON.parse((await boundedFile(manifest, 100_000)).toString('utf8'));
  if (input?.authorized !== true || !Array.isArray(input.documents ?? []) || (input.documents ?? []).length > LIMITS.documents)
    throw new Error('Explicit operator authorization and bounded documents are required');
  const documents = [];
  let total = 0;
  for (const doc of input.documents ?? []) {
    if (!doc || typeof doc.path !== 'string' || !doc.path) throw new Error('Local document path is required');
    const bytes = await boundedFile(resolve(dirname(resolve(manifest)), doc.path), LIMITS.documentBytes);
    total += bytes.length;
    if (total > LIMITS.totalDocumentBytes) throw new Error('Document batch exceeds byte limit');
    documents.push({ name: doc.name ?? basename(doc.path), media_type: doc.media_type,
      source_kind: doc.source_kind, source_ref: doc.source_ref, bytes });
  }
  const result = await collectSources({ ...input, documents });
  // Never write a collection into a public site tree. The trusted operator chooses a private location.
  const output = resolve(destination);
  const root = resolve('.generated/collection');
  if (!output.startsWith(root + '/') || !output.endsWith('.json'))
    throw new Error('Collection output must be a JSON file under .generated/collection');
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ status: result.status, counts: result.counts, output }));
  if (result.status !== 'complete') process.exitCode = 1;
} catch (error) {
  console.error('COLLECTION_BLOCKED: ' + (error.code ?? error.message));
  process.exitCode = 1;
}
