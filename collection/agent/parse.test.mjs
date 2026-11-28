import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PARSE_LIMITS, ParseError, parseAsset } from './parse.mjs';

const python = process.env.CODEX_PRIMARY_RUNTIME_PYTHON || 'python3';
let directory;

// These fixtures contain real format bytes. No document parser or OCR result is
// mocked. Only explicitly named provider-contract tests below use mock hooks.
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'buyersite-parser-test-'));
  execFileSync(
    python,
    [
      '-c',
      String.raw`
import io, os, struct, sys, zipfile, zlib
import fitz
from docx import Document
from docx.oxml import OxmlElement
from openpyxl import Workbook
from PIL import Image, ImageDraw, ImageFont

directory = sys.argv[1]
def path(name): return os.path.join(directory, name)

document = fitz.open()
for text in ['PRODUCT MODEL A100\nMass: 25 kg', 'POWER DATA\nRated power: 120 W']:
    page = document.new_page()
    page.insert_text((72, 72), text, fontsize=16)
document.save(path('embedded.pdf'))
document.close()

document = fitz.open()
for _ in range(41): document.new_page()
document.save(path('too-many-pages.pdf'))
document.close()

image = Image.new('RGB', (1400, 360), 'white')
draw = ImageDraw.Draw(image)
font = ImageFont.truetype('DejaVuSans.ttf', 64)
draw.text((45, 50), 'PRODUCT MODEL A100', fill='black', font=font)
draw.text((45, 170), 'MASS 25 KG', fill='black', font=font)
image.save(path('label.png'))
png = io.BytesIO()
image.save(png, format='PNG')
document = fitz.open()
page = document.new_page(width=700, height=180)
page.insert_image(page.rect, stream=png.getvalue())
document.save(path('scanned.pdf'))
document.close()
document = fitz.open()
page = document.new_page()
page.insert_text((72, 72), 'EMBEDDED FIRST PAGE', fontsize=16)
page = document.new_page(width=700, height=180)
page.insert_image(page.rect, stream=png.getvalue())
document.save(path('mixed.pdf'))
document.close()

document = Document()
document.add_paragraph('PRODUCT MODEL A100')
document.add_paragraph('Application: testing\nPower: 120 W')
table = document.add_table(rows=1, cols=2)
table.rows[0].cells[0].text = 'Mass'
table.rows[0].cells[1].text = '25 kg'
document.add_paragraph('Last paragraph')
document.save(path('catalog.docx'))

document = Document()
document.add_paragraph('Visible body paragraph')
control = OxmlElement('w:sdt')
content = OxmlElement('w:sdtContent')
paragraph = OxmlElement('w:p')
run = OxmlElement('w:r')
text = OxmlElement('w:t')
text.text = 'UNPARSED_CONTROL_TEXT'
run.append(text)
paragraph.append(run)
content.append(paragraph)
control.append(content)
document.element.body.insert_element_before(control, 'w:sectPr')
document.save(path('control.docx'))

workbook = Workbook()
sheet = workbook.active
sheet.title = 'Products'
sheet.append(['Model', 'Mass kg', 'Derived mass'])
sheet.append(['A100', 25, '=B2*2'])
sheet = workbook.create_sheet('Specs')
sheet['A3'] = 'Rated power'
sheet['B3'] = 120
sheet['C3'] = False
sheet['D3'] = 0
workbook.save(path('catalog.xlsx'))

with zipfile.ZipFile(path('expansion.docx'), 'w', compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr('word/document.xml', 'A' * 2_000_000)
with zipfile.ZipFile(path('entities.docx'), 'w') as archive:
    archive.writestr('word/document.xml', '<!DOCTYPE x [<!ENTITY x "data">]><x>&x;</x>')

def chunk(kind, value):
    return struct.pack('>I', len(value)) + kind + value + struct.pack('>I', zlib.crc32(kind + value))
huge_png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 50000, 50000, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b'')) + chunk(b'IEND', b'')
with open(path('huge.png'), 'wb') as target: target.write(huge_png)
`,
      directory,
    ],
    { timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
});

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture(filename, options = {}) {
  return parseAsset(
    { filename, bytes: await readFile(join(directory, filename)) },
    { python, ...options },
  );
}

test('UTF-8 text, Markdown, JSON and CSV keep actual text and source line ranges', async () => {
  for (const [filename, text] of [
    ['notes.txt', '产品型号：A100\n重量：25 kg'],
    ['notes.md', '# Product\r\nModel: A100'],
    ['notes.json', '{\n  "model": "A100"\n}'],
    ['notes.csv', 'model,mass\nA100,25'],
  ]) {
    const result = await parseAsset({ filename, bytes: Buffer.from(text) });
    assert.equal(result.status, 'ready');
    assert.equal(result.segments[0].method, 'provided-text');
    assert.deepEqual(result.segments[0].locator, {
      kind: 'lines',
      start_line: 1,
      end_line: text.split(/\r\n|\n/).length,
    });
    assert.equal(result.segments[0].text, text.replaceAll('\r\n', '\n'));
  }
  const text = Array.from({ length: 83 }, (_, index) => `line ${index + 1}`).join('\n');
  const result = await parseAsset({ filename: 'long.txt', bytes: Buffer.from(text) });
  assert.deepEqual(result.segments[1].locator, { kind: 'lines', start_line: 81, end_line: 83 });
  assert.equal(result.segments.map((segment) => segment.text).join('\n'), text);
});

test('invalid UTF-8, malformed JSON, empty input and text limits fail explicitly', async () => {
  for (const [filename, bytes, code] of [
    ['bad.txt', Buffer.from([0xc3, 0x28]), 'INVALID_UTF8'],
    ['bad.json', Buffer.from('{bad'), 'INVALID_JSON'],
    ['empty.txt', Buffer.alloc(0), 'EMPTY_ASSET'],
    ['binary.txt', Buffer.from('abc\0def'), 'BINARY_TEXT'],
    ['too-long.txt', Buffer.from('a'.repeat(PARSE_LIMITS.textCharacters + 1)), 'TEXT_LIMIT'],
    ['large.txt', Buffer.alloc(PARSE_LIMITS.inputBytes + 1), 'INPUT_TOO_LARGE'],
  ]) {
    await assert.rejects(
      parseAsset({ filename, bytes }),
      (error) => error instanceof ParseError && error.code === code,
    );
  }
  const blank = await parseAsset({ filename: 'blank.txt', bytes: Buffer.from(' \n ') });
  assert.equal(blank.status, 'partial');
  assert.ok(blank.warnings.some((warning) => warning.code === 'NO_TEXT'));
  assert.deepEqual(blank.segments, []);
});

test('real embedded PDF returns independent page evidence', async () => {
  const result = await fixture('embedded.pdf');
  assert.equal(result.status, 'ready');
  assert.equal(result.segments.length, 2);
  assert.deepEqual(
    result.segments.map((segment) => segment.locator),
    [
      { kind: 'page', page: 1 },
      { kind: 'page', page: 2 },
    ],
  );
  assert.ok(result.segments.every((segment) => segment.method === 'embedded-text'));
  assert.match(result.segments[0].text, /A100/);
  assert.match(result.segments[1].text, /120 W/);
});

test('real scanned PDF is OCRed locally and retains page locator', async () => {
  const result = await fixture('scanned.pdf');
  assert.equal(result.status, 'ready');
  assert.equal(result.segments[0].method, 'ocr');
  assert.deepEqual(result.segments[0].locator, { kind: 'page', page: 1 });
  assert.match(result.segments[0].text, /A100/);
  assert.match(result.segments[0].text, /25 KG/);
  assert.ok(result.warnings.some((warning) => warning.code === 'OCR_UNVERIFIED'));
});

test('mixed PDFs parse each page independently and retain available evidence when OCR is missing', async () => {
  const result = await fixture('mixed.pdf');
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    result.segments.map((segment) => [segment.locator.page, segment.method]),
    [
      [1, 'embedded-text'],
      [2, 'ocr'],
    ],
  );
  assert.match(result.segments[1].text, /A100/);
  const missingOcr = await fixture('mixed.pdf', { ocrLanguage: 'not_installed_test_language' });
  assert.equal(missingOcr.status, 'partial');
  assert.equal(missingOcr.segments.length, 1);
  assert.equal(missingOcr.segments[0].locator.page, 1);
  assert.ok(
    missingOcr.warnings.some(
      (warning) => warning.code === 'PDF_PAGE_NEEDS_OCR' && warning.message.includes('Page 2'),
    ),
  );
});

test('real DOCX paragraphs and table rows preserve order and original body identifiers', async () => {
  const result = await fixture('catalog.docx');
  assert.equal(result.status, 'ready');
  assert.equal(result.segments.length, 4);
  assert.equal(result.segments[0].text, 'PRODUCT MODEL A100');
  assert.deepEqual(result.segments[1].locator, {
    kind: 'lines',
    start_line: 2,
    end_line: 3,
    paragraph: 2,
  });
  assert.equal(result.segments[2].text, 'Mass\t25 kg');
  assert.deepEqual(result.segments[2].locator, {
    kind: 'lines',
    start_line: 4,
    end_line: 4,
    table: 1,
    row: 1,
  });
  assert.equal(result.segments[3].locator.start_line, 5);
  assert.ok(result.warnings.some((warning) => warning.code === 'DOCX_LINE_LOCATORS'));
});

test('real DOCX content controls cannot be silently reported as a complete body parse', async () => {
  const result = await fixture('control.docx');
  assert.equal(result.status, 'partial');
  assert.equal(result.segments[0].text, 'Visible body paragraph');
  assert.ok(
    result.warnings.some(
      (warning) => warning.code === 'DOCX_UNSUPPORTED_BLOCK' && warning.message.includes('sdt'),
    ),
  );
});

test('real XLSX keeps sheets, row numbers, zero and false; formulas are never evaluated', async () => {
  const result = await fixture('catalog.xlsx');
  assert.equal(result.status, 'partial');
  const product = result.segments.find(
    (segment) => segment.locator.sheet === 'Products' && segment.locator.start_line === 2,
  );
  assert.match(product.text, /A2: A100/);
  assert.match(product.text, /B2: 25/);
  assert.match(product.text, /formula result unavailable; formula==B2\*2/);
  assert.doesNotMatch(product.text, /C2: 50/);
  const specification = result.segments.find((segment) => segment.locator.sheet === 'Specs');
  assert.deepEqual(specification.locator, {
    kind: 'sheet',
    sheet: 'Specs',
    start_line: 3,
    end_line: 3,
  });
  assert.match(specification.text, /C3: false/);
  assert.match(specification.text, /D3: 0/);
  assert.ok(
    result.warnings.some(
      (warning) =>
        warning.code === 'FORMULA_VALUE_MISSING' && warning.message.includes('Products!C2'),
    ),
  );
});

test('real PNG OCR extracts actual label text and explicitly identifies absent visual interpretation', async () => {
  const result = await fixture('label.png');
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.missing_processors, ['image_vision']);
  assert.equal(result.segments[0].method, 'ocr');
  assert.deepEqual(result.segments[0].locator, { kind: 'image' });
  assert.match(result.segments[0].text, /A100/);
  assert.match(result.segments[0].text, /25 KG/);
});

test('mock vision hook contract is separate from real OCR and receives original PNG bytes', async () => {
  const bytes = await readFile(join(directory, 'label.png'));
  let calls = 0;
  const result = await parseAsset(
    { filename: 'label.png', media_type: 'image/png', bytes },
    {
      python,
      describeImage: async (asset) => {
        calls += 1;
        assert.equal(asset.filename, 'label.png');
        assert.equal(asset.media_type, 'image/png');
        assert.ok(asset.bytes.equals(bytes));
        return { text: 'Mock visual observation for provider-contract verification only.' };
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.status, 'ready');
  assert.ok(result.segments.some((segment) => segment.method === 'ocr'));
  assert.equal(result.segments.at(-1).method, 'vision');
  assert.deepEqual(result.missing_processors, []);
});

test('missing OCR language and missing Python are explicit and generate no invented text', async () => {
  const result = await fixture('scanned.pdf', { ocrLanguage: 'not_installed_test_language' });
  assert.equal(result.status, 'needs_processor');
  assert.deepEqual(result.segments, []);
  assert.ok(result.missing_processors.includes('tesseract:not_installed_test_language'));
  const withoutPython = await fixture('embedded.pdf', { python: '/no-such-buyersite-python' });
  assert.equal(withoutPython.status, 'needs_processor');
  assert.deepEqual(withoutPython.missing_processors, ['python']);
  assert.deepEqual(withoutPython.segments, []);
});

test('document limits reject overlong PDFs, expansion bombs, XML entities and huge image headers', async () => {
  for (const [filename, code] of [
    ['too-many-pages.pdf', 'PDF_PAGE_LIMIT'],
    ['expansion.docx', 'ZIP_EXPANSION_LIMIT'],
    ['entities.docx', 'UNSAFE_XML'],
    ['huge.png', 'IMAGE_PIXEL_LIMIT'],
  ]) {
    await assert.rejects(
      fixture(filename),
      (error) => error instanceof ParseError && error.code === code,
    );
  }
});

test('audio without an ASR provider reports needs_processor, without a fabricated transcript', async () => {
  const result = await parseAsset({
    filename: 'recording.wav',
    bytes: Buffer.from('untranscribed source bytes'),
  });
  assert.equal(result.status, 'needs_processor');
  assert.deepEqual(result.missing_processors, ['transcription']);
  assert.deepEqual(result.segments, []);
});

test('mock ASR hook contract preserves real supplied timestamps; this does not test live ASR', async () => {
  const bytes = Buffer.from('mock audio bytes');
  const result = await parseAsset(
    { filename: 'recording.wav', bytes },
    {
      transcribe: async (asset) => {
        assert.ok(asset.bytes.equals(bytes));
        return { segments: [{ text: 'Model A100 weighs 25 kg.', start_ms: 1200, end_ms: 3800 }] };
      },
    },
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.segments[0].method, 'transcription');
  assert.deepEqual(result.segments[0].locator, { kind: 'audio', start_ms: 1200, end_ms: 3800 });
  const untimed = await parseAsset(
    { filename: 'recording.wav', bytes },
    { transcribe: async () => ({ text: 'Mock transcript.' }) },
  );
  assert.equal(untimed.status, 'ready');
  assert.deepEqual(untimed.segments[0].locator, { kind: 'audio' });
  assert.ok(untimed.warnings.some((warning) => warning.code === 'TRANSCRIPT_UNTIMED'));
});

test('mock ASR provider failures and invalid timestamps never appear as accepted evidence', async () => {
  const asset = { filename: 'recording.wav', bytes: Buffer.from('mock') };
  const failed = await parseAsset(asset, {
    transcribe: async () => {
      throw new Error('Mock provider unavailable');
    },
  });
  assert.equal(failed.status, 'needs_processor');
  assert.deepEqual(failed.segments, []);
  assert.ok(failed.warnings.some((warning) => warning.code === 'TRANSCRIPTION_FAILED'));
  await assert.rejects(
    parseAsset(asset, {
      transcribe: async () => ({ segments: [{ text: 'Invalid range', start_ms: 20, end_ms: 10 }] }),
    }),
    { code: 'INVALID_TRANSCRIPT_TIME' },
  );
});

test('unsupported formats identify a converter requirement rather than treating bytes as text', async () => {
  const result = await parseAsset({ filename: 'legacy.doc', bytes: Buffer.from('opaque source') });
  assert.equal(result.status, 'needs_processor');
  assert.deepEqual(result.missing_processors, ['format_converter']);
  assert.deepEqual(result.segments, []);
});
