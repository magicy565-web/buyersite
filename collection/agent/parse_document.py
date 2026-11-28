#!/usr/bin/env python3
"""Bounded, local document extraction. Stdout is one JSON result, never logs.

Source bytes arrive on stdin. This worker never extracts ZIP paths to disk,
evaluates spreadsheet formulas, downloads models, or follows document links.
"""

import argparse
import importlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import warnings
import zipfile


MAX_INPUT_BYTES = 25 * 1024 * 1024
MAX_TEXT_CHARACTERS = 250_000
MAX_PDF_PAGES = 80
# Leave time for the final OCR call and serialization before the outer watchdog.
PDF_OCR_START_BUDGET_SECONDS = 115
MAX_PDF_OCR_PIXELS = 350_000_000
MAX_IMAGE_PIXELS = 25_000_000
MAX_IMAGE_FRAMES = 20
MAX_TOTAL_IMAGE_PIXELS = 50_000_000
MAX_ZIP_BYTES = 100 * 1024 * 1024
MAX_ZIP_ENTRIES = 3_000
MAX_ZIP_ENTRY_BYTES = 40 * 1024 * 1024
MAX_ZIP_RATIO = 500
MAX_SHEETS = 30
MAX_ROWS = 10_000
MAX_COLUMNS = 256
MAX_CELLS = 100_000
MAX_SEGMENTS = 10_000
OCR_TIMEOUT_SECONDS = 20
OCR_OUTPUT_BYTES = 2 * 1024 * 1024


class ParseFailure(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class Extractor:
    def __init__(self, language):
        self.result = {
            "status": "ready", "segments": [], "warnings": [],
            "missing_processors": [],
        }
        self.language = language
        self.characters = 0
        self.incomplete = False
        self.ocr_checked = False
        self.tesseract = None

    def warn(self, code, message, incomplete=False):
        warning = {"code": code, "message": message}
        if warning not in self.result["warnings"]:
            self.result["warnings"].append(warning)
        self.incomplete = self.incomplete or incomplete

    def missing(self, processor, message):
        if processor not in self.result["missing_processors"]:
            self.result["missing_processors"].append(processor)
        self.warn("PROCESSOR_UNAVAILABLE", message, incomplete=True)

    def dependency(self, name, processor):
        try:
            return importlib.import_module(name)
        except ImportError:
            self.missing(processor, f"Install the Python dependency for {processor} from collection/agent/requirements.txt.")
            return None

    def add(self, segment_id, text, locator, method):
        if not text or not text.strip():
            return
        self.characters += len(text)
        if self.characters > MAX_TEXT_CHARACTERS:
            raise ParseFailure("TEXT_LIMIT", f"Extracted text exceeds {MAX_TEXT_CHARACTERS} characters; split the source. No truncated result was accepted.")
        if len(self.result["segments"]) >= MAX_SEGMENTS:
            raise ParseFailure("SEGMENT_LIMIT", f"Source exceeds {MAX_SEGMENTS} text segments; split the source.")
        self.result["segments"].append({
            "id": segment_id, "text": text, "locator": locator, "method": method,
        })

    def finish(self):
        if not self.result["segments"]:
            self.warn("NO_TEXT", "No readable text was extracted from this source.", incomplete=True)
        if self.result["missing_processors"] and not self.result["segments"]:
            self.result["status"] = "needs_processor"
        elif self.incomplete:
            self.result["status"] = "partial"
        return self.result

    def check_ocr(self):
        if self.ocr_checked:
            return bool(self.tesseract)
        self.ocr_checked = True
        executable = shutil.which("tesseract")
        if not executable:
            self.missing("tesseract", "Tesseract OCR is unavailable; install Tesseract and the source languages.")
            return False
        try:
            output, _, code = bounded_process([executable, "--list-langs"], timeout=5, output_limit=64 * 1024)
        except ParseFailure as error:
            self.missing("tesseract", f"Tesseract language detection failed: {error}")
            return False
        if code != 0:
            self.missing("tesseract", "Tesseract could not list its installed OCR languages.")
            return False
        installed = set(output.decode("utf-8", errors="replace").splitlines()[1:])
        unavailable = [language for language in self.language.split("+") if language not in installed]
        if unavailable:
            for language in unavailable:
                self.missing(f"tesseract:{language}", f"The Tesseract OCR language '{language}' is not installed. Supply a text-based source or install that language.")
            return False
        self.tesseract = executable
        return True

    def ocr(self, image, location):
        if not self.check_ocr():
            return None
        check_pixels(image.width, image.height)
        with tempfile.TemporaryDirectory(prefix="buyersite-ocr-") as directory:
            image_path = os.path.join(directory, "source.png")
            image.convert("RGB").save(image_path, format="PNG")
            try:
                output, errors, code = bounded_process(
                    [self.tesseract, image_path, "stdout", "-l", self.language, "--psm", "3"],
                    timeout=OCR_TIMEOUT_SECONDS, output_limit=OCR_OUTPUT_BYTES,
                )
            except ParseFailure as error:
                self.warn(error.code, f"{location}: {error}", incomplete=True)
                return None
            if code != 0:
                detail = errors.decode("utf-8", errors="replace").strip()[:500]
                self.warn("OCR_FAILED", f"{location}: OCR failed.{(' ' + detail) if detail else ''}", incomplete=True)
                return None
            try:
                text = output.decode("utf-8", errors="strict")
            except UnicodeDecodeError:
                self.warn("OCR_INVALID_UTF8", f"{location}: OCR returned invalid UTF-8.", incomplete=True)
                return None
            if not text.strip():
                self.warn("OCR_NO_TEXT", f"{location}: OCR found no readable text; visual content may still be present.", incomplete=True)
            return text


def bounded_process(arguments, timeout, output_limit):
    """Bound time, stdout, and stderr without retaining unbounded pipe buffers."""
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        try:
            child = subprocess.Popen(arguments, stdin=subprocess.DEVNULL, stdout=output, stderr=errors, shell=False)
        except OSError as error:
            raise ParseFailure("PROCESSOR_START_FAILED", f"Could not start processor: {error}") from error
        deadline = time.monotonic() + timeout
        try:
            while True:
                if os.fstat(output.fileno()).st_size > output_limit or os.fstat(errors.fileno()).st_size > 64 * 1024:
                    raise ParseFailure("OCR_OUTPUT_LIMIT", "OCR output exceeded its byte limit.")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ParseFailure("OCR_TIMEOUT", f"OCR exceeded {timeout} seconds.")
                try:
                    code = child.wait(timeout=min(0.05, remaining))
                    break
                except subprocess.TimeoutExpired:
                    continue
            if os.fstat(output.fileno()).st_size > output_limit or os.fstat(errors.fileno()).st_size > 64 * 1024:
                raise ParseFailure("OCR_OUTPUT_LIMIT", "OCR output exceeded its byte limit.")
            output.seek(0)
            errors.seek(0)
            return output.read(output_limit), errors.read(64 * 1024), code
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()


def check_pixels(width, height):
    if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
        raise ParseFailure("IMAGE_PIXEL_LIMIT", f"Images must have between 1 and {MAX_IMAGE_PIXELS} pixels.")


def check_office_zip(data):
    """Inspect expansion before Office libraries parse any document XML."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ZIP_ENTRIES:
                raise ParseFailure("ZIP_ENTRY_LIMIT", f"Office archive exceeds {MAX_ZIP_ENTRIES} entries.")
            if sum(entry.file_size for entry in entries) > MAX_ZIP_BYTES:
                raise ParseFailure("ZIP_EXPANSION_LIMIT", f"Expanded Office archive exceeds {MAX_ZIP_BYTES} bytes.")
            names = set()
            for entry in entries:
                if entry.filename in names:
                    raise ParseFailure("ZIP_DUPLICATE_ENTRY", "Office archive contains duplicate paths.")
                names.add(entry.filename)
                if entry.flag_bits & 1:
                    raise ParseFailure("ENCRYPTED_DOCUMENT", "Encrypted Office archives require an unencrypted copy.")
                if entry.file_size > MAX_ZIP_ENTRY_BYTES or entry.file_size > max(entry.compress_size, 1024) * MAX_ZIP_RATIO:
                    raise ParseFailure("ZIP_EXPANSION_LIMIT", "An Office archive entry exceeds the expansion or compression-ratio limit.")
                if entry.filename.lower().endswith((".xml", ".rels")):
                    # Check declarations even when defusedxml is not installed.
                    # Reject UTF-16/32 XML as well, so NUL bytes cannot hide a DTD.
                    with archive.open(entry) as xml:
                        tail = b""
                        while block := xml.read(64 * 1024):
                            probe = (tail + block).upper()
                            if b"<!DOCTYPE" in probe or b"<!ENTITY" in probe or b"\x00" in probe:
                                raise ParseFailure("UNSAFE_XML", "Office XML contains an unsupported DTD, entity declaration, or non-UTF-8 encoding.")
                            tail = probe[-16:]
            return names
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError) as error:
        raise ParseFailure("INVALID_OFFICE_ARCHIVE", f"The Office document is not a readable ZIP package: {error}") from error


def parse_pdf(data, extractor):
    fitz = extractor.dependency("fitz", "pymupdf")
    if fitz is None:
        return
    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception as error:
        raise ParseFailure("INVALID_PDF", "The PDF cannot be opened.") from error
    with document:
        if document.needs_pass:
            raise ParseFailure("ENCRYPTED_DOCUMENT", "The PDF requires a password; supply an unencrypted copy.")
        if document.page_count > MAX_PDF_PAGES:
            raise ParseFailure("PDF_PAGE_LIMIT", f"PDF has {document.page_count} pages; the limit is {MAX_PDF_PAGES}. Split it before import.")
        image_module = None
        ocr_deadline = time.monotonic() + PDF_OCR_START_BUDGET_SECONDS
        ocr_pixels = 0
        for page_number, page in enumerate(document, start=1):
            locator = {"kind": "page", "page": page_number}
            try:
                text = page.get_text("text", sort=True)
            except Exception as error:
                extractor.warn("PDF_PAGE_FAILED", f"Page {page_number}: embedded text extraction failed ({type(error).__name__}).", incomplete=True)
                text = ""
            if text.strip():
                extractor.add(f"p{page_number}", text, locator, "embedded-text")
                # An embedded text layer does not prove captions inside a raster
                # picture were read. Surface this limitation instead of claiming
                # the full visual page has been understood.
                if page.get_images():
                    extractor.warn("PDF_IMAGES_NOT_OCRD", f"Page {page_number}: embedded text was read; text inside separate images and visual meaning were not analyzed.", incomplete=True)
                continue
            if not extractor.check_ocr():
                extractor.warn("PDF_PAGE_NEEDS_OCR", f"Page {page_number}: no embedded text; OCR is required.", incomplete=True)
                continue
            if image_module is None:
                image_module = extractor.dependency("PIL.Image", "pillow")
            if image_module is None:
                continue
            # Render at 150 dpi. Reject pathological page sizes before allocating.
            scale = 150 / 72
            width = max(1, int(page.rect.width * scale) + 1)
            height = max(1, int(page.rect.height * scale) + 1)
            check_pixels(width, height)
            pixels = width * height
            if time.monotonic() >= ocr_deadline or ocr_pixels + pixels > MAX_PDF_OCR_PIXELS:
                extractor.warn("PDF_OCR_BUDGET", f"Page {page_number}: skipped OCR because the document budget was exhausted. Supply a smaller excerpt or a text-based copy.", incomplete=True)
                continue
            ocr_pixels += pixels
            try:
                bitmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
                image = image_module.frombytes("RGB", (bitmap.width, bitmap.height), bitmap.samples)
                text = extractor.ocr(image, f"Page {page_number}")
            except ParseFailure:
                raise
            except Exception as error:
                extractor.warn("PDF_RENDER_FAILED", f"Page {page_number}: rendering failed ({type(error).__name__}).", incomplete=True)
                continue
            if text:
                extractor.add(f"p{page_number}", text, locator, "ocr")
                extractor.warn("OCR_UNVERIFIED", f"Page {page_number}: OCR output needs source verification for names, numbers, and tables.")


def parse_docx(data, extractor):
    names = check_office_zip(data)
    if "word/document.xml" not in names:
        raise ParseFailure("INVALID_DOCX", "The package has no Word document body.")
    docx = extractor.dependency("docx", "python-docx")
    if docx is None:
        return
    try:
        document = docx.Document(io.BytesIO(data))
    except Exception as error:
        raise ParseFailure("INVALID_DOCX", "The DOCX cannot be opened.") from error
    namespace = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    line = 1
    paragraph = 0
    table = 0
    for block in document.element.body:
        if block.tag == namespace + "p":
            paragraph += 1
            value = docx.text.paragraph.Paragraph(block, document).text
            count = max(1, len(value.splitlines()))
            extractor.add(
                f"paragraph{paragraph}", value,
                {"kind": "lines", "start_line": line, "end_line": line + count - 1, "paragraph": paragraph},
                "embedded-text",
            )
            line += count
        elif block.tag == namespace + "tbl":
            table += 1
            table_object = docx.table.Table(block, document)
            for row_number, row in enumerate(table_object.rows, start=1):
                # Merged cells can repeat the same underlying XML object.
                cells = []
                seen = set()
                for cell in row.cells:
                    if cell._tc not in seen:
                        cells.append(cell.text.replace("\n", " / "))
                        seen.add(cell._tc)
                    if cell.tables:
                        extractor.warn("DOCX_NESTED_TABLE", f"Table {table}, row {row_number}: a nested table was not flattened; supply it as a spreadsheet or text.", incomplete=True)
                extractor.add(
                    f"table{table}-r{row_number}", "\t".join(cells),
                    {"kind": "lines", "start_line": line, "end_line": line, "table": table, "row": row_number},
                    "embedded-text",
                )
                line += 1
        elif isinstance(block.tag, str) and block.tag != namespace + "sectPr":
            block_name = block.tag.rsplit("}", 1)[-1]
            extractor.warn("DOCX_UNSUPPORTED_BLOCK", f"Body block '{block_name}' was not interpreted; supply its contents as ordinary paragraphs, a spreadsheet, or text.", incomplete=True)
    extras = []
    if any(name.startswith("word/media/") for name in names):
        extras.append("embedded images")
    if any(name.startswith(("word/header", "word/footer")) for name in names):
        extras.append("headers/footers")
    if any(name in names for name in ["word/footnotes.xml", "word/endnotes.xml", "word/comments.xml"]):
        extras.append("notes/comments")
    xml = document.element.xml
    if "txbxContent" in xml or "<w:ins" in xml or "<w:del" in xml:
        extras.append("text boxes or tracked changes")
    if extras:
        extractor.warn("DOCX_EXTRA_CONTENT", "Body paragraphs and tables were read. Additional content was not interpreted: " + ", ".join(extras) + ".", incomplete=True)
    extractor.warn("DOCX_LINE_LOCATORS", "DOCX line locators refer to extraction order, not printed page layout; paragraph/table identifiers identify the original body elements.")


def cell_text(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def parse_xlsx(data, extractor):
    names = check_office_zip(data)
    if "xl/workbook.xml" not in names:
        raise ParseFailure("INVALID_XLSX", "The package has no Excel workbook.")
    openpyxl = extractor.dependency("openpyxl", "openpyxl")
    if openpyxl is None:
        return
    try:
        document = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=False, keep_links=False)
        cached = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True, keep_links=False)
    except Exception as error:
        raise ParseFailure("INVALID_XLSX", "The XLSX cannot be opened.") from error
    cells = 0
    try:
        if len(document.worksheets) > MAX_SHEETS:
            raise ParseFailure("SHEET_LIMIT", f"Workbook exceeds {MAX_SHEETS} sheets.")
        for sheet_number, sheet in enumerate(document.worksheets, start=1):
            if (sheet.max_row or 0) > MAX_ROWS or (sheet.max_column or 0) > MAX_COLUMNS:
                raise ParseFailure("SHEET_DIMENSION_LIMIT", f"Sheet '{sheet.title}' exceeds {MAX_ROWS} rows or {MAX_COLUMNS} columns; split the source.")
            if (sheet.max_row or 0) * (sheet.max_column or 0) + cells > MAX_CELLS:
                raise ParseFailure("CELL_LIMIT", f"Workbook exceeds the {MAX_CELLS}-cell processing limit.")
            values = cached[sheet.title].iter_rows()
            for row_number, row in enumerate(sheet.iter_rows(), start=1):
                cached_row = next(values, ())
                cells += len(row)
                if len(row) > MAX_COLUMNS:
                    raise ParseFailure("SHEET_DIMENSION_LIMIT", f"Sheet '{sheet.title}' exceeds {MAX_COLUMNS} columns; split the source.")
                if cells > MAX_CELLS or row_number > MAX_ROWS:
                    raise ParseFailure("CELL_LIMIT", f"Workbook exceeds {MAX_CELLS} cells or {MAX_ROWS} rows per sheet.")
                parts = []
                for column_index, cell in enumerate(row):
                    if cell.value is None:
                        continue
                    value = cell.value
                    if cell.data_type == "f":
                        cached_value = cached_row[column_index].value if column_index < len(cached_row) else None
                        if cached_value is None:
                            value = "[formula result unavailable; formula=" + str(value) + "]"
                            extractor.warn("FORMULA_VALUE_MISSING", f"{sheet.title}!{cell.coordinate}: the formula has no cached result and was not evaluated.", incomplete=True)
                        else:
                            value = "[cached formula result=" + cell_text(cached_value) + "; formula=" + str(value) + "]"
                            extractor.warn("FORMULA_CACHE_UNVERIFIED", f"{sheet.title}!{cell.coordinate}: the saved formula result was used without recalculation; it may be stale.", incomplete=True)
                    parts.append(f"{cell.coordinate}: {cell_text(value)}")
                if parts:
                    extractor.add(
                        f"s{sheet_number}-r{row_number}", "\t".join(parts),
                        {"kind": "sheet", "sheet": sheet.title, "start_line": row_number, "end_line": row_number},
                        "embedded-text",
                    )
            if sheet.sheet_state != "visible":
                extractor.warn("HIDDEN_SHEET_INCLUDED", f"Hidden sheet '{sheet.title}' was included with its original sheet name.")
        if any(name.startswith(("xl/media/", "xl/charts/", "xl/drawings/")) for name in names):
            extractor.warn("XLSX_VISUAL_CONTENT", "Cell values were read; embedded images, charts, and drawing text were not interpreted.", incomplete=True)
    finally:
        document.close()
        cached.close()


def parse_image(data, extractor):
    image_module = extractor.dependency("PIL.Image", "pillow")
    image_ops = extractor.dependency("PIL.ImageOps", "pillow")
    if image_module is None or image_ops is None:
        return
    image_module.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    total_pixels = 0
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", image_module.DecompressionBombWarning)
            with image_module.open(io.BytesIO(data)) as source:
                frames = getattr(source, "n_frames", 1)
                if frames > MAX_IMAGE_FRAMES:
                    raise ParseFailure("IMAGE_FRAME_LIMIT", f"Image exceeds {MAX_IMAGE_FRAMES} frames; supply separate still images.")
                for frame in range(frames):
                    source.seek(frame)
                    check_pixels(source.width, source.height)
                    total_pixels += source.width * source.height
                    if total_pixels > MAX_TOTAL_IMAGE_PIXELS:
                        raise ParseFailure("IMAGE_PIXEL_LIMIT", f"Image frames exceed {MAX_TOTAL_IMAGE_PIXELS} total pixels.")
                    source.load()
                    oriented = image_ops.exif_transpose(source)
                    if oriented.mode in ("RGBA", "LA") or "transparency" in oriented.info:
                        rgba = oriented.convert("RGBA")
                        image = image_module.new("RGB", rgba.size, "white")
                        image.paste(rgba, mask=rgba.getchannel("A"))
                    else:
                        image = oriented.convert("RGB")
                    text = extractor.ocr(image, f"Image frame {frame + 1}")
                    locator = {"kind": "image"}
                    if frames > 1:
                        locator["frame"] = frame + 1
                    if text:
                        extractor.add(f"image{frame + 1}", text, locator, "ocr")
                        extractor.warn("OCR_UNVERIFIED", "OCR output needs source verification for names, numbers, and tables.")
    except (image_module.DecompressionBombError, image_module.DecompressionBombWarning) as error:
        raise ParseFailure("IMAGE_PIXEL_LIMIT", f"Image exceeds {MAX_IMAGE_PIXELS} pixels.") from error
    except ParseFailure:
        raise
    except Exception as error:
        raise ParseFailure("INVALID_IMAGE", f"The raster image could not be decoded ({type(error).__name__}).") from error


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--format", choices=["pdf", "docx", "xlsx", "image"], required=True)
    parser.add_argument("--ocr-language", default="eng")
    arguments = parser.parse_args()
    data = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
    if not data:
        raise ParseFailure("EMPTY_ASSET", "The source file is empty.")
    if len(data) > MAX_INPUT_BYTES:
        raise ParseFailure("INPUT_TOO_LARGE", f"Input exceeds {MAX_INPUT_BYTES} bytes.")
    extractor = Extractor(arguments.ocr_language)
    {"pdf": parse_pdf, "docx": parse_docx, "xlsx": parse_xlsx, "image": parse_image}[arguments.format](data, extractor)
    return extractor.finish()


if __name__ == "__main__":
    try:
        response = main()
        exit_code = 0
    except ParseFailure as error:
        response = {"error": {"code": error.code, "message": str(error)}}
        exit_code = 1
    except Exception as error:
        response = {"error": {"code": "DOCUMENT_PARSE_FAILED", "message": f"Document extraction failed ({type(error).__name__}). Supply a readable copy."}}
        exit_code = 1
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))
    sys.stdout.flush()
    sys.exit(exit_code)
