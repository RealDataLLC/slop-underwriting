"""Excel / CSV rent-roll ingestion for CRE underwriting.

Handles common rent-roll quirks such as multi-header rows, merged cells,
and summary/totals rows that should be excluded from the data.
"""

from __future__ import annotations

import io
import logging
import re
from typing import Optional

import pandas as pd

logger = logging.getLogger(__name__)

# Patterns that mark a row as a totals / subtotals row (case-insensitive).
_TOTALS_PATTERN = re.compile(r"^\s*(total|subtotal|grand\s*total)\s*$", re.IGNORECASE)

# When auto-detecting the header row we skip rows where *all* cells are
# blank or where the row looks like a title (single populated cell).
_MAX_HEADER_SCAN_ROWS = 20


def parse_excel(file_bytes: bytes, filename: str) -> list[dict]:
    """Parse a rent-roll spreadsheet (XLSX or CSV) into a list of row dicts.

    Args:
        file_bytes: Raw file content (e.g. downloaded from Supabase Storage).
        filename: Original filename, used to distinguish ``.xlsx`` from
            ``.csv`` formats.

    Returns:
        A list of dicts where each dict represents one data row.  Keys are
        the auto-detected column headers.  Totals / subtotals rows and
        completely blank rows are excluded.

    Raises:
        ValueError: If *file_bytes* is empty or the file extension is
            unsupported.
    """
    if not file_bytes:
        raise ValueError("file_bytes must not be empty")

    lower = filename.lower()

    if lower.endswith(".csv"):
        return _parse_csv(file_bytes)
    elif lower.endswith((".xlsx", ".xls")):
        return _parse_xlsx(file_bytes)
    else:
        raise ValueError(
            f"Unsupported file extension for '{filename}'. "
            "Expected .xlsx, .xls, or .csv."
        )


# ---------------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------------


def _parse_csv(file_bytes: bytes) -> list[dict]:
    """Parse a CSV file, auto-detecting the header row."""
    df = pd.read_csv(io.BytesIO(file_bytes), header=None, dtype=str)
    return _normalise_dataframe(df)


# ---------------------------------------------------------------------------
# XLSX
# ---------------------------------------------------------------------------


def _parse_xlsx(file_bytes: bytes) -> list[dict]:
    """Parse an Excel workbook (first sheet), handling merged cells.

    ``openpyxl`` is used as the engine so that merged-cell ranges are
    automatically forward-filled by pandas.
    """
    df = pd.read_excel(
        io.BytesIO(file_bytes),
        header=None,
        engine="openpyxl",
        dtype=str,
    )
    return _normalise_dataframe(df)


# ---------------------------------------------------------------------------
# Shared normalisation
# ---------------------------------------------------------------------------


def _normalise_dataframe(df: pd.DataFrame) -> list[dict]:
    """Auto-detect the header row, clean up, and return a list of dicts.

    Steps:
        1. Drop completely blank rows / columns.
        2. Forward-fill merged cells (NaN propagation).
        3. Detect the header row (first row with >= 2 non-blank cells).
        4. Assign headers and drop rows above the header.
        5. Remove totals / subtotals rows.
        6. Return remaining rows as ``list[dict]``.
    """
    # Drop fully empty rows and columns
    df = df.dropna(how="all").reset_index(drop=True)
    df = df.dropna(axis=1, how="all")

    if df.empty:
        return []

    # Forward-fill to handle merged cells (common in rent rolls)
    df = df.ffill(axis=0)

    header_idx = _detect_header_row(df)

    if header_idx is not None:
        headers = [
            str(val).strip() if pd.notna(val) else f"column_{i}"
            for i, val in enumerate(df.iloc[header_idx])
        ]
        df = df.iloc[header_idx + 1:].reset_index(drop=True)
    else:
        # Fallback: use generic column names
        headers = [f"column_{i}" for i in range(len(df.columns))]

    df.columns = headers  # type: ignore[assignment]

    # Drop rows that are completely blank after header assignment
    df = df.dropna(how="all").reset_index(drop=True)

    # Remove totals / subtotals rows
    df = _drop_totals_rows(df)

    # Convert to list of dicts, skipping any remaining all-NaN rows
    records: list[dict] = []
    for _, row in df.iterrows():
        record = {
            k: (v.strip() if isinstance(v, str) else v)
            for k, v in row.items()
            if pd.notna(v)
        }
        if record:
            records.append(record)

    return records


def _detect_header_row(df: pd.DataFrame) -> Optional[int]:
    """Return the index of the most likely header row.

    Heuristic: the first row (within the first ``_MAX_HEADER_SCAN_ROWS``
    rows) that has at least two non-blank cells and where the majority
    of populated cells look like text (not purely numeric).
    """
    scan_limit = min(len(df), _MAX_HEADER_SCAN_ROWS)
    for idx in range(scan_limit):
        row = df.iloc[idx]
        non_blank = [
            str(v).strip()
            for v in row
            if pd.notna(v) and str(v).strip() != ""
        ]
        if len(non_blank) < 2:
            continue

        # Check that the majority of cells are textual (not pure numbers)
        text_cells = sum(1 for v in non_blank if not _is_numeric(v))
        if text_cells >= len(non_blank) / 2:
            return idx

    return None


def _is_numeric(value: str) -> bool:
    """Return ``True`` if *value* looks like a number."""
    cleaned = value.replace(",", "").replace("$", "").replace("%", "").strip()
    try:
        float(cleaned)
        return True
    except ValueError:
        return False


def _drop_totals_rows(df: pd.DataFrame) -> pd.DataFrame:
    """Remove rows whose first non-blank cell matches a totals pattern."""
    if df.empty:
        return df

    first_col = df.columns[0]
    mask = df[first_col].apply(
        lambda v: bool(_TOTALS_PATTERN.match(str(v).strip()))
        if pd.notna(v)
        else False
    )
    dropped_count = mask.sum()
    if dropped_count:
        logger.debug("Dropped %d totals/subtotals row(s).", dropped_count)
    return df[~mask].reset_index(drop=True)
