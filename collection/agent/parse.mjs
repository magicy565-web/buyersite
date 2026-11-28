import { spawn } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PARSE_LIMITS = Object.freeze({
  inputBytes: 25 * 1024 * 1024,
  textCharacters: 250_000,
  pdfPages: 80,
  pdfSubprocessMilliseconds: 155_000,
  imagePixels: 25_000_000,
  expandedZipBytes: 100 * 1024 * 1024,
  subprocessMilliseconds: 60_000,
  subprocessOutputBytes: 4 * 1024 * 1024,
});

export class ParseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ParseError';
    this.code = code;
  }
}

const SCRIPT = fileURLToPath(new URL('./parse_document.py', import.meta.url));
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.tsv']);
const AUDIO_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.m4a',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.flac',
  '.webm',
]);
const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.tif',
  '.tiff',
  '.bmp',
  '.gif',
]);
const TEXT_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
]);
const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function emptyResult() {
  return { status: 'ready', segments: [], warnings: [], missing_processors: [] };
}

function characterCount(text) {
  let count = 0;
  const iterator = text[Symbol.iterator]();
  while (!iterator.next().done) {
    count += 1;
    if (count > PARSE_LIMITS.textCharacters) break;
  }
  return count;
}

function missing(processor, message) {
  return {
    status: 'needs_processor',
    segments: [],
    warnings: [{ code: 'PROCESSOR_UNAVAILABLE', message }],
    missing_processors: [processor],
  };
}

function validateAsset(asset) {
  if (
    !asset ||
    typeof asset.filename !== 'string' ||
    !asset.filename.trim() ||
    asset.filename.length > 512
  ) {
    throw new ParseError('INVALID_FILENAME', 'A filename of at most 512 characters is required.');
  }
  if (!(asset.bytes instanceof Uint8Array)) {
    throw new ParseError('INVALID_BYTES', 'Asset bytes must be a Buffer or Uint8Array.');
  }
  if (asset.bytes.byteLength === 0)
    throw new ParseError('EMPTY_ASSET', 'The source file is empty.');
  if (asset.bytes.byteLength > PARSE_LIMITS.inputBytes) {
    throw new ParseError('INPUT_TOO_LARGE', `Input exceeds ${PARSE_LIMITS.inputBytes} bytes.`);
  }
  if (asset.media_type != null && typeof asset.media_type !== 'string') {
    throw new ParseError('INVALID_MEDIA_TYPE', 'media_type must be a string.');
  }
  return {
    filename: asset.filename,
    media_type: (asset.media_type || '').split(';', 1)[0].trim().toLowerCase(),
    bytes: Buffer.from(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength),
  };
}

function assetKind(asset) {
  const extension = extname(asset.filename).toLowerCase();
  if (asset.media_type === 'application/pdf' || extension === '.pdf') return 'pdf';
  if (asset.media_type === DOCX_TYPE || extension === '.docx') return 'docx';
  if (asset.media_type === XLSX_TYPE || extension === '.xlsx') return 'xlsx';
  if (
    IMAGE_EXTENSIONS.has(extension) ||
    /^image\/(png|jpeg|webp|tiff|bmp|gif)$/.test(asset.media_type)
  )
    return 'image';
  if (asset.media_type.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (TEXT_EXTENSIONS.has(extension) || TEXT_TYPES.has(asset.media_type)) return 'text';
  return 'unsupported';
}

function textResult(asset) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(asset.bytes);
  } catch {
    throw new ParseError(
      'INVALID_UTF8',
      'Text must be UTF-8; convert this source before importing it.',
    );
  }
  if (text.includes('\0'))
    throw new ParseError(
      'BINARY_TEXT',
      'Text contains NUL bytes and cannot be imported as plain text.',
    );
  if (characterCount(text) > PARSE_LIMITS.textCharacters) {
    throw new ParseError(
      'TEXT_LIMIT',
      `Extracted text exceeds ${PARSE_LIMITS.textCharacters} characters; split the source.`,
    );
  }
  if (
    asset.media_type === 'application/json' ||
    extname(asset.filename).toLowerCase() === '.json'
  ) {
    try {
      JSON.parse(text);
    } catch {
      throw new ParseError('INVALID_JSON', 'The JSON source is not valid JSON.');
    }
  }
  const result = emptyResult();
  const lines = text.split(/\r\n|\n|\r/);
  for (let start = 0; start < lines.length; start += 80) {
    const block = lines.slice(start, start + 80).join('\n');
    if (!block.trim()) continue;
    result.segments.push({
      id: `l${start + 1}-${Math.min(start + 80, lines.length)}`,
      text: block,
      locator: {
        kind: 'lines',
        start_line: start + 1,
        end_line: Math.min(start + 80, lines.length),
      },
      method: 'provided-text',
    });
  }
  if (!result.segments.length) {
    result.status = 'partial';
    result.warnings.push({
      code: 'NO_TEXT',
      message: 'The source contains no non-whitespace text.',
    });
  }
  return result;
}

function runDocumentParser(asset, kind, options) {
  const executable = options.python || process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3';
  if (typeof executable !== 'string' || !executable)
    throw new ParseError('INVALID_PYTHON', 'python must be an executable name or path.');
  const language = options.ocrLanguage ?? 'eng';
  if (
    typeof language !== 'string' ||
    !/^[A-Za-z0-9_]+(?:\+[A-Za-z0-9_]+)*$/.test(language) ||
    language.length > 80
  ) {
    throw new ParseError(
      'INVALID_OCR_LANGUAGE',
      'OCR languages must be Tesseract language codes joined by +.',
    );
  }
  const budget =
    kind === 'pdf' ? PARSE_LIMITS.pdfSubprocessMilliseconds : PARSE_LIMITS.subprocessMilliseconds;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [SCRIPT, '--format', kind, '--ocr-language', language], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, OMP_THREAD_LIMIT: '1' },
      detached: process.platform !== 'win32',
    });
    let finished = false;
    let outputBytes = 0;
    let errorBytes = 0;
    const output = [];
    const errors = [];
    const stop = () => {
      // Terminate the OCR child as well if the outer document budget expires.
      if (process.platform !== 'win32' && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
          return;
        } catch {
          /* The process may already have exited. */
        }
      }
      child.kill('SIGKILL');
    };
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => {
      stop();
      finish(
        new ParseError(
          'PARSER_TIMEOUT',
          `Document parsing exceeded ${budget} ms; split the source.`,
        ),
      );
    }, budget);
    timer.unref();
    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        finish(
          null,
          missing(
            'python',
            'Python is unavailable; install the document parser requirements and configure python.',
          ),
        );
      } else
        finish(
          new ParseError(
            'PARSER_START_FAILED',
            `Could not start the document parser: ${error.message}`,
          ),
        );
    });
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > PARSE_LIMITS.subprocessOutputBytes) {
        stop();
        finish(
          new ParseError(
            'PARSER_OUTPUT_LIMIT',
            'Document parser output exceeded its byte limit; split the source.',
          ),
        );
      } else output.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      errorBytes += chunk.length;
      if (errorBytes <= 16_384) errors.push(chunk);
    });
    // A parser can reject its input before consuming stdin. Its structured result
    // remains authoritative in that case, rather than an incidental EPIPE.
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE' && !finished) {
        stop();
        finish(
          new ParseError(
            'PARSER_INPUT_FAILED',
            `Could not pass bytes to the parser: ${error.message}`,
          ),
        );
      }
    });
    child.on('close', (code) => {
      if (finished) return;
      let result;
      try {
        result = JSON.parse(Buffer.concat(output).toString('utf8'));
      } catch {
        const detail = Buffer.concat(errors).toString('utf8').trim().slice(0, 1000);
        finish(
          new ParseError(
            'PARSER_FAILED',
            `Document parser returned no valid result (exit ${code}).${detail ? ` ${detail}` : ''}`,
          ),
        );
        return;
      }
      if (result.error) {
        finish(
          new ParseError(
            result.error.code || 'PARSER_FAILED',
            result.error.message || 'Document parsing failed.',
          ),
        );
      } else if (
        code !== 0 ||
        !Array.isArray(result.segments) ||
        !Array.isArray(result.warnings) ||
        !Array.isArray(result.missing_processors)
      ) {
        finish(new ParseError('PARSER_FAILED', 'Document parser returned an invalid result.'));
      } else finish(null, result);
    });
    child.stdin.end(asset.bytes);
  });
}

async function invokeHook(hook, asset, processor) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => hook(asset)),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new ParseError('PROCESSOR_TIMEOUT', `${processor} exceeded 120 seconds.`)),
          120_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function checkedText(value, processor) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ParseError('INVALID_PROCESSOR_OUTPUT', `${processor} returned no non-empty text.`);
  }
  if (characterCount(value) > PARSE_LIMITS.textCharacters) {
    throw new ParseError(
      'TEXT_LIMIT',
      `${processor} returned more than ${PARSE_LIMITS.textCharacters} characters.`,
    );
  }
  return value;
}

async function transcribeAsset(asset, transcribe) {
  if (typeof transcribe !== 'function') {
    return missing(
      'transcription',
      'An audio transcription provider is required; no transcript was generated.',
    );
  }
  const result = emptyResult();
  let response;
  try {
    response = await invokeHook(transcribe, asset, 'Transcription');
  } catch (error) {
    result.status = 'needs_processor';
    result.missing_processors.push('transcription');
    result.warnings.push({
      code: 'TRANSCRIPTION_FAILED',
      message: `Transcription failed: ${error.message}`,
    });
    return result;
  }
  const entries =
    Array.isArray(response?.segments) && response.segments.length
      ? response.segments
      : [{ text: typeof response === 'string' ? response : response?.text }];
  if (entries.length > 10_000)
    throw new ParseError('SEGMENT_LIMIT', 'Transcription returned more than 10,000 segments.');
  let characters = 0;
  let hasUntimed = false;
  for (const [index, entry] of entries.entries()) {
    const text = checkedText(entry?.text, 'Transcription');
    characters += characterCount(text);
    if (characters > PARSE_LIMITS.textCharacters)
      throw new ParseError('TEXT_LIMIT', 'The full transcript exceeds the extracted text limit.');
    const locator = { kind: 'audio' };
    if (entry.start_ms != null || entry.end_ms != null) {
      if (
        !Number.isFinite(entry.start_ms) ||
        !Number.isFinite(entry.end_ms) ||
        entry.start_ms < 0 ||
        entry.end_ms <= entry.start_ms
      ) {
        throw new ParseError(
          'INVALID_TRANSCRIPT_TIME',
          'Transcript timestamps must include finite, increasing start_ms and end_ms.',
        );
      }
      locator.start_ms = entry.start_ms;
      locator.end_ms = entry.end_ms;
    } else hasUntimed = true;
    result.segments.push({ id: `a${index + 1}`, text, locator, method: 'transcription' });
  }
  if (hasUntimed) {
    result.warnings.push({
      code: 'TRANSCRIPT_UNTIMED',
      message:
        'The provider returned text without timestamps; evidence links can identify only the whole recording.',
    });
  }
  return result;
}

async function addImageDescription(asset, result, describeImage) {
  if (
    result.missing_processors.some((processor) => processor === 'python' || processor === 'pillow')
  ) {
    result.warnings.push({
      code: 'IMAGE_VALIDATION_REQUIRED',
      message:
        'Visual interpretation was deferred because local image dimensions and format could not be validated.',
    });
    return result;
  }
  if (typeof describeImage !== 'function') {
    result.missing_processors.push('image_vision');
    result.warnings.push({
      code: 'IMAGE_VISION_UNAVAILABLE',
      message:
        'Only visible text was processed. A vision provider is required to interpret visual content.',
    });
    result.status = result.segments.length ? 'partial' : 'needs_processor';
    return result;
  }
  try {
    const response = await invokeHook(describeImage, asset, 'Image vision');
    const text = checkedText(
      typeof response === 'string' ? response : response?.text,
      'Image vision',
    );
    const characters =
      result.segments.reduce((sum, segment) => sum + characterCount(segment.text), 0) +
      characterCount(text);
    if (characters > PARSE_LIMITS.textCharacters)
      throw new ParseError(
        'TEXT_LIMIT',
        'OCR and vision output together exceed the extracted text limit.',
      );
    result.segments.push({ id: 'vision1', text, locator: { kind: 'image' }, method: 'vision' });
    const ocrFailed = result.warnings.some((warning) =>
      [
        'OCR_TIMEOUT',
        'OCR_OUTPUT_LIMIT',
        'OCR_FAILED',
        'OCR_INVALID_UTF8',
        'PROCESSOR_START_FAILED',
      ].includes(warning.code),
    );
    result.status = result.missing_processors.length || ocrFailed ? 'partial' : 'ready';
  } catch (error) {
    if (
      error instanceof ParseError &&
      ['TEXT_LIMIT', 'INVALID_PROCESSOR_OUTPUT'].includes(error.code)
    )
      throw error;
    result.missing_processors.push('image_vision');
    result.warnings.push({
      code: 'IMAGE_VISION_FAILED',
      message: `Image interpretation failed: ${error.message}`,
    });
    result.status = result.segments.length ? 'partial' : 'needs_processor';
  }
  return result;
}

/**
 * Extract source content with locators. Missing processors never fabricate text.
 * Hooks receive original bytes. Transcription timestamps use milliseconds.
 * Hard limits and corrupt inputs throw ParseError; unavailable processors are
 * returned explicitly so the agent can request a usable source or setup.
 */
export async function parseAsset(input, options = {}) {
  const asset = validateAsset(input);
  const kind = assetKind(asset);
  if (kind === 'text') return textResult(asset);
  if (kind === 'audio') return transcribeAsset(asset, options.transcribe);
  if (kind === 'unsupported') {
    return missing(
      'format_converter',
      'This format is unsupported. Supply UTF-8 text, PDF, DOCX, XLSX, a raster image, or a supported audio recording.',
    );
  }
  const result = await runDocumentParser(asset, kind, options);
  return kind === 'image' ? addImageDescription(asset, result, options.describeImage) : result;
}
