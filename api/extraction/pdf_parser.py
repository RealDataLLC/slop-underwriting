"""PDF ingestion pipeline for CRE underwriting documents.

Extracts text and tabular data from PDF files using pdfplumber,
with OCR fallback via pytesseract + pdf2image for scanned pages.
"""

from __future__ import annotations

import io
import logging
from typing import Optional

import pdfplumber

logger = logging.getLogger(__name__)

# Minimum characters on a page before we consider it "too little text"
# and attempt OCR fallback.
_OCR_THRESHOLD = 50


def parse_pdf(file_bytes: bytes) -> dict[int, str]:
    """Extract text from every page of a PDF.

    Uses pdfplumber for native text extraction.  When a page yields fewer
    than 50 characters, falls back to OCR (pytesseract + pdf2image).
    If OCR dependencies are not installed the pdfplumber result is kept
    and a warning is logged.

    Args:
        file_bytes: Raw PDF content (e.g. downloaded from Supabase Storage).

    Returns:
        A dict mapping 1-indexed page numbers to their extracted text.

    Raises:
        ValueError: If *file_bytes* is empty.
        pdfplumber.pdfminer.pdfparser.PDFSyntaxError: If the bytes are not a
            valid PDF.
    """
    if not file_bytes:
        raise ValueError("file_bytes must not be empty")

    pages: dict[int, str] = {}

    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for idx, page in enumerate(pdf.pages):
            page_number = idx + 1
            text = (page.extract_text() or "").strip()

            if len(text) < _OCR_THRESHOLD:
                ocr_text = _ocr_page(file_bytes, page_number)
                if ocr_text is not None:
                    text = ocr_text

            pages[page_number] = text

    return pages


def extract_tables(file_bytes: bytes) -> list[list[list[str]]]:
    """Extract tabular data from every page of a PDF.

    Each table is represented as a list of rows, where each row is a list
    of cell strings.  ``None`` cells (from merged / empty cells) are
    replaced with empty strings for downstream convenience.

    Args:
        file_bytes: Raw PDF content.

    Returns:
        A flat list of tables found across all pages.  Each table is
        ``list[list[str]]``.

    Raises:
        ValueError: If *file_bytes* is empty.
    """
    if not file_bytes:
        raise ValueError("file_bytes must not be empty")

    all_tables: list[list[list[str]]] = []

    with pdfplumber.open(io.BytesIO(file_bytes)) as pdf:
        for page in pdf.pages:
            page_tables = page.extract_tables()
            if not page_tables:
                continue
            for table in page_tables:
                cleaned: list[list[str]] = []
                for row in table:
                    cleaned.append([
                        (cell.strip() if cell else "")
                        for cell in row
                    ])
                all_tables.append(cleaned)

    return all_tables


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _ocr_page(file_bytes: bytes, page_number: int) -> Optional[str]:
    """Attempt OCR on a single page.  Returns ``None`` on import failure."""
    try:
        from pdf2image import convert_from_bytes  # type: ignore[import-untyped]
        import pytesseract  # type: ignore[import-untyped]
    except ImportError:
        logger.warning(
            "OCR dependencies (pytesseract / pdf2image) are not installed. "
            "Returning pdfplumber text for page %d.",
            page_number,
        )
        return None

    try:
        images = convert_from_bytes(
            file_bytes,
            first_page=page_number,
            last_page=page_number,
        )
        if not images:
            return None
        text: str = pytesseract.image_to_string(images[0])
        return text.strip()
    except Exception:
        logger.exception(
            "OCR failed for page %d; falling back to pdfplumber text.",
            page_number,
        )
        return None
