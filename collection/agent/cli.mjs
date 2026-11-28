import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInformationAgent } from './index.mjs';
import { createEnterpriseLibraryAdapter } from './library.mjs';
import { createOpenAIProvider } from './provider.mjs';
import { KnowledgeError, requireText, sha256 } from './contracts.mjs';

const MIME = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.webm': 'audio/webm',
  '.flac': 'audio/flac',
};

export async function runRequest(request, env = process.env) {
  const principal = {
    enterpriseId: requireText(env.KI_ENTERPRISE_ID, 'KI_ENTERPRISE_ID', 200),
    actorId: requireText(env.KI_ACTOR_ID, 'KI_ACTOR_ID', 200),
  };
  if (
    !request ||
    typeof request.command !== 'string' ||
    !request.args ||
    typeof request.args !== 'object'
  )
    throw new KnowledgeError('INVALID_REQUEST', 'Use {command,args}');
  const provider =
    env.KI_MODEL && env.KI_OPENAI_API_KEY
      ? createOpenAIProvider({
          apiKey: env.KI_OPENAI_API_KEY,
          model: env.KI_MODEL,
          visionModel: env.KI_VISION_MODEL,
          transcriptionModel: env.KI_TRANSCRIPTION_MODEL,
        })
      : undefined;
  const library = env.KI_LIBRARY_ORIGIN
    ? createEnterpriseLibraryAdapter({
        baseUrl: env.KI_LIBRARY_ORIGIN,
        enterpriseId: principal.enterpriseId,
        headers: env.KI_LIBRARY_TOKEN ? { Authorization: `Bearer ${env.KI_LIBRARY_TOKEN}` } : {},
      })
    : undefined;
  const agent = createInformationAgent({
    databasePath: requireText(env.KI_DATABASE_PATH, 'KI_DATABASE_PATH', 4096),
    principal,
    library,
    provider,
    parserOptions: {
      ...(env.KI_PYTHON ? { python: env.KI_PYTHON } : {}),
      ocrLanguage: env.KI_OCR_LANGUAGE || 'eng',
    },
  });
  try {
    if (request.command === 'ingest-file') {
      const root = await realpath(requireText(env.KI_LIBRARY_ROOT, 'KI_LIBRARY_ROOT', 4096));
      const path = await realpath(resolve(root, requireText(request.args.path, 'path', 4096)));
      if (path === root || !path.startsWith(root + sep))
        throw new KnowledgeError(
          'OUTSIDE_LIBRARY_ROOT',
          'File must be inside the configured library directory',
        );
      const info = await stat(path);
      if (!info.isFile() || info.size > 25 * 1024 * 1024)
        throw new KnowledgeError(
          'INVALID_ASSET_SIZE',
          'Only regular files up to 25 MiB can be ingested',
        );
      const bytes = await readFile(path);
      const digest = sha256(bytes);
      return await agent.ingestAsset({
        source_id: `local:${relative(root, path)}`,
        revision: request.args.revision || digest,
        enterprise_id: principal.enterpriseId,
        entity: request.args.entity,
        filename: relative(root, path),
        media_type: MIME[extname(path).toLowerCase()] || 'application/octet-stream',
        bytes,
        sha256: digest,
      });
    }
    const commands = {
      'list-library': agent.listLibraryDocuments,
      'ingest-library': agent.ingestLibraryDocument,
      analyze: agent.analyzeSource,
      knowledge: agent.getKnowledge,
      questions: agent.getNextQuestions,
      review: agent.reviewFact,
      answer: agent.answerQuestion,
      defer: agent.deferQuestion,
      supplement: agent.linkSupplement,
      resume: agent.resumeField,
      audit: agent.audit,
    };
    const command = Object.hasOwn(commands, request.command) && commands[request.command];
    if (!command) throw new KnowledgeError('UNKNOWN_COMMAND', 'Unknown knowledge agent command');
    return await command(request.args);
  } finally {
    agent.close();
  }
}

async function main() {
  const requestPath = process.argv[2];
  if (!requestPath)
    throw new KnowledgeError(
      'REQUEST_REQUIRED',
      'Usage: node collection/agent/cli.mjs <request.json>',
    );
  const info = await stat(requestPath);
  if (!info.isFile() || info.size > 256 * 1024)
    throw new KnowledgeError('REQUEST_TOO_LARGE', 'Request JSON must be a file of at most 256 KiB');
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  console.log(JSON.stringify(await runRequest(request), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        error: error.code || 'REQUEST_FAILED',
        message:
          error instanceof KnowledgeError
            ? error.message
            : 'Request failed; check the source and host configuration.',
      }),
    );
    process.exitCode = 1;
  });
}
