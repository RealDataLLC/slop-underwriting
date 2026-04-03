"""
LLM-based extraction engine for commercial real estate offering memorandums.

Implements a 5-pass pipeline using Anthropic Claude models:
  Pass 1 — Page Classification (Haiku)
  Pass 2 — Property & Tenant Extraction (Sonnet)
  Pass 3 — Lease Extraction (Sonnet)
  Pass 4 — Financial Extraction (Sonnet)
  Pass 5 — Reconciliation (pure logic, no LLM)

Passes 2-4 run in parallel via ThreadPoolExecutor.
"""

from __future__ import annotations

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import anthropic

from api.shared.supabase_client import ANTHROPIC_API_KEY

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Client & constants
# ---------------------------------------------------------------------------

_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

MODEL_HAIKU = "claude-haiku-4-5-20251001"
MODEL_SONNET = "claude-sonnet-4-20250514"

MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 2.0  # seconds

# Maximum pages to send in a single classification batch
_CLASSIFICATION_BATCH_SIZE = 40

# Page types that are relevant for each extraction pass
_PROPERTY_PAGE_TYPES = {"cover", "other"}
_LEASE_PAGE_TYPES = {"lease_summary", "financials"}
_FINANCIAL_PAGE_TYPES = {"financials"}

# Fields considered critical for a complete deal analysis
_CRITICAL_FIELDS = [
    "property.name",
    "property.address",
    "property.property_type",
    "property.square_footage",
    "tenant.name",
    "lease.type",
    "lease.start_date",
    "lease.end_date",
    "financials_as_stated.asking_price",
    "financials_as_stated.noi_year1",
]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _call_anthropic(
    *,
    model: str,
    system: str,
    user_message: str,
    max_tokens: int = 4096,
) -> dict[str, Any]:
    """Call the Anthropic API with retry logic and JSON parsing.

    The system prompt instructs the model to return only valid JSON.
    We parse the response text and return it as a Python dict.

    Raises:
        RuntimeError: If all retries are exhausted.
        json.JSONDecodeError: If the final response is not valid JSON.
    """
    last_exception: Exception | None = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = _client.messages.create(
                model=model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": user_message}],
            )
            text = response.content[0].text

            # Strip markdown code fences if present
            cleaned = text.strip()
            if cleaned.startswith("```"):
                # Remove opening fence (```json or ```)
                first_newline = cleaned.index("\n")
                cleaned = cleaned[first_newline + 1 :]
                # Remove closing fence
                if cleaned.rstrip().endswith("```"):
                    cleaned = cleaned.rstrip()[:-3].rstrip()

            return json.loads(cleaned)

        except anthropic.RateLimitError as exc:
            last_exception = exc
            wait = RETRY_BACKOFF_BASE ** attempt
            logger.warning(
                "Rate limited on attempt %d/%d, retrying in %.1fs",
                attempt,
                MAX_RETRIES,
                wait,
            )
            time.sleep(wait)

        except anthropic.APIStatusError as exc:
            last_exception = exc
            if exc.status_code >= 500:
                wait = RETRY_BACKOFF_BASE ** attempt
                logger.warning(
                    "Server error %d on attempt %d/%d, retrying in %.1fs",
                    exc.status_code,
                    attempt,
                    MAX_RETRIES,
                    wait,
                )
                time.sleep(wait)
            else:
                raise

        except json.JSONDecodeError as exc:
            last_exception = exc
            logger.warning(
                "JSON parse error on attempt %d/%d: %s",
                attempt,
                MAX_RETRIES,
                exc,
            )
            if attempt < MAX_RETRIES:
                time.sleep(1)

    raise RuntimeError(
        f"Anthropic API call failed after {MAX_RETRIES} attempts: {last_exception}"
    )


def _filter_pages(
    pages: dict[int, str],
    classifications: list[dict],
    allowed_types: set[str],
    *,
    require_financial_data: bool = False,
) -> dict[int, str]:
    """Return the subset of *pages* whose classification matches *allowed_types*.

    If *require_financial_data* is True, only pages flagged with
    ``has_financial_data=True`` are included (regardless of type).
    """
    selected_page_numbers: set[int] = set()
    for cls in classifications:
        page_num = cls["page_number"]
        page_type = cls.get("type", "other")
        has_fin = cls.get("has_financial_data", False)

        if require_financial_data:
            if has_fin:
                selected_page_numbers.add(page_num)
        elif page_type in allowed_types:
            selected_page_numbers.add(page_num)

    return {pn: pages[pn] for pn in sorted(selected_page_numbers) if pn in pages}


def _format_pages_for_prompt(pages: dict[int, str]) -> str:
    """Serialize a page dict into a labelled text block for inclusion in a prompt."""
    parts: list[str] = []
    for page_num in sorted(pages):
        parts.append(f"--- PAGE {page_num} ---\n{pages[page_num]}")
    return "\n\n".join(parts)


def _nested_get(data: dict, dotted_key: str) -> Any:
    """Retrieve a value from a nested dict using a dotted key path."""
    keys = dotted_key.split(".")
    current = data
    for k in keys:
        if not isinstance(current, dict):
            return None
        current = current.get(k)
    return current


# ---------------------------------------------------------------------------
# Pass 1 — Page Classification
# ---------------------------------------------------------------------------

_CLASSIFICATION_SYSTEM_PROMPT = """\
You are a commercial real estate document classifier. You will be given the
text of pages extracted from a commercial real estate offering memorandum (OM).

For each page, classify its type and whether it contains financial data.

Valid page types:
- "cover" — Title page, table of contents, or executive summary
- "financials" — Income/expense statements, pro-forma, operating history, cash flow projections
- "lease_summary" — Lease abstract, lease terms, rent schedule, tenant obligations
- "rent_roll" — Rent roll table showing units, tenants, and rents
- "photos" — Property photos or renderings (usually has minimal text)
- "maps" — Location maps, aerials, site plans, demographics
- "other" — Property description, tenant overview, market analysis, area info, or anything else

Return ONLY valid JSON — an array of objects, one per page, with these fields:
- "page_number" (int)
- "type" (string, one of the types above)
- "has_financial_data" (bool) — true if the page contains any dollar amounts,
  NOI, cap rates, rent figures, or financial projections
"""


def classify_pages(pages: dict[int, str]) -> list[dict]:
    """Classify every page in the document by type and financial relevance.

    Uses Claude Haiku for speed/cost efficiency. Large documents are batched
    to stay within context limits.

    Args:
        pages: Mapping of page number to extracted text.

    Returns:
        List of classification dicts, each containing ``page_number``,
        ``type``, and ``has_financial_data``.
    """
    page_numbers = sorted(pages.keys())
    all_classifications: list[dict] = []

    for batch_start in range(0, len(page_numbers), _CLASSIFICATION_BATCH_SIZE):
        batch_nums = page_numbers[batch_start : batch_start + _CLASSIFICATION_BATCH_SIZE]
        batch_pages = {pn: pages[pn] for pn in batch_nums}
        page_text = _format_pages_for_prompt(batch_pages)

        user_msg = (
            f"Classify the following {len(batch_nums)} pages from a commercial "
            f"real estate offering memorandum.\n\n{page_text}"
        )

        result = _call_anthropic(
            model=MODEL_HAIKU,
            system=_CLASSIFICATION_SYSTEM_PROMPT,
            user_message=user_msg,
            max_tokens=2048,
        )

        # Result should be a list; handle if wrapped in a key
        if isinstance(result, dict):
            # Try common wrapper keys
            for key in ("classifications", "pages", "results"):
                if key in result and isinstance(result[key], list):
                    result = result[key]
                    break
            else:
                result = [result]

        all_classifications.extend(result)

    return all_classifications


# ---------------------------------------------------------------------------
# Pass 2 — Property + Tenant Extraction
# ---------------------------------------------------------------------------

_PROPERTY_TENANT_SYSTEM_PROMPT = """\
You are a commercial real estate analyst. Extract property and tenant
information from the following pages of an offering memorandum.

Return ONLY valid JSON with the following structure:

{
  "property": {
    "name": "<string or null>",
    "address": "<full street address or null>",
    "city": "<string or null>",
    "state": "<2-letter code or null>",
    "zip_code": "<string or null>",
    "county": "<string or null>",
    "property_type": "<retail|office|industrial|multifamily|mixed_use|medical|other or null>",
    "property_subtype": "<e.g. NNN, strip mall, flex, etc. or null>",
    "year_built": <int or null>,
    "year_renovated": <int or null>,
    "building_square_footage": <float or null>,
    "land_square_footage": <float or null>,
    "land_acres": <float or null>,
    "parking_spaces": <int or null>,
    "parking_ratio": "<string or null>",
    "number_of_units": <int or null>,
    "number_of_stories": <int or null>,
    "zoning": "<string or null>",
    "construction_type": "<string or null>",
    "roof_type": "<string or null>",
    "hvac": "<string or null>"
  },
  "tenant": {
    "name": "<string or null>",
    "trade_name": "<DBA or brand name or null>",
    "tenant_type": "<national_credit|regional|local|government or null>",
    "credit_rating": "<S&P or Moody's rating or null>",
    "parent_company": "<string or null>",
    "industry": "<string or null>",
    "number_of_locations": <int or null>,
    "annual_revenue": <float or null>,
    "founded_year": <int or null>,
    "publicly_traded": <bool or null>,
    "stock_ticker": "<string or null>"
  },
  "confidence": {
    "property": <float 0.0-1.0>,
    "tenant": <float 0.0-1.0>
  }
}

Rules:
- Use null for any field you cannot determine with reasonable confidence.
- confidence scores reflect how certain you are about the extracted data overall.
  1.0 = all fields clearly stated; 0.5 = many fields inferred or uncertain;
  0.0 = essentially guessing.
- square_footage values should be numeric (no commas).
- property_type must be one of the listed enum values or null.
"""


def extract_property_tenant(
    pages: dict[int, str], classifications: list[dict]
) -> dict[str, Any]:
    """Extract property and tenant information (Pass 2).

    Focuses on cover pages, property descriptions, and any page that might
    contain property/tenant details.

    Args:
        pages: Full page text mapping.
        classifications: Output from :func:`classify_pages`.

    Returns:
        Dict with ``property``, ``tenant``, and ``confidence`` keys.
    """
    # Include cover, other (often property descriptions), and any page with
    # relevant info.  We cast a wide net because property info can appear
    # on many page types.
    relevant = _filter_pages(
        pages, classifications, {"cover", "other", "lease_summary"}
    )
    if not relevant:
        # Fallback: use the first 10 pages
        first_pages = sorted(pages.keys())[:10]
        relevant = {pn: pages[pn] for pn in first_pages}

    page_text = _format_pages_for_prompt(relevant)

    return _call_anthropic(
        model=MODEL_SONNET,
        system=_PROPERTY_TENANT_SYSTEM_PROMPT,
        user_message=(
            "Extract property and tenant information from these OM pages.\n\n"
            + page_text
        ),
        max_tokens=4096,
    )


# ---------------------------------------------------------------------------
# Pass 3 — Lease Extraction
# ---------------------------------------------------------------------------

_LEASE_SYSTEM_PROMPT = """\
You are a commercial real estate lease analyst. Extract lease terms from
the following pages of an offering memorandum.

Return ONLY valid JSON with the following structure:

{
  "lease": {
    "type": "<NNN|NN|modified_gross|gross|absolute_net|ground or null>",
    "start_date": "<YYYY-MM-DD or null>",
    "end_date": "<YYYY-MM-DD or null>",
    "term_years": <float or null>,
    "term_remaining_years": <float or null>,
    "base_rent_annual": <float or null>,
    "base_rent_monthly": <float or null>,
    "base_rent_psf": <float or null>,
    "rent_bumps": [
      {
        "effective_date": "<YYYY-MM-DD or null>",
        "year_number": <int or null>,
        "new_rent_annual": <float or null>,
        "new_rent_monthly": <float or null>,
        "new_rent_psf": <float or null>,
        "increase_type": "<fixed|percentage|cpi or null>",
        "increase_value": <float or null>
      }
    ],
    "options": [
      {
        "type": "<renewal|expansion|termination|ROFR|purchase or null>",
        "term_years": <float or null>,
        "notice_period_days": <int or null>,
        "rent_terms": "<description of option rent terms or null>"
      }
    ],
    "tenant_responsibilities": {
      "real_estate_taxes": <bool or null>,
      "insurance": <bool or null>,
      "cam": <bool or null>,
      "utilities": <bool or null>,
      "roof_structure": <bool or null>,
      "hvac": <bool or null>,
      "management_fee": <bool or null>
    },
    "landlord_responsibilities": {
      "roof_structure": <bool or null>,
      "hvac": <bool or null>,
      "parking_lot": <bool or null>
    },
    "security_deposit": <float or null>,
    "guarantor": "<personal|corporate|none or null>",
    "guarantee_type": "<full|limited|none or null>",
    "sublease_allowed": <bool or null>,
    "assignment_allowed": <bool or null>,
    "percentage_rent": <bool or null>,
    "percentage_rent_breakpoint": <float or null>,
    "percentage_rent_rate": <float or null>
  },
  "confidence": {
    "lease": <float 0.0-1.0>
  }
}

Rules:
- Use null for any field you cannot determine with reasonable confidence.
- Dates should be in YYYY-MM-DD format. If only year is known, use YYYY-01-01.
- rent_bumps should list all scheduled rent increases in chronological order.
  If a bump schedule says "10% every 5 years", expand into individual entries
  if enough info is available; otherwise describe the pattern.
- For NNN leases, tenant_responsibilities taxes/insurance/cam should all be true.
- confidence reflects how clearly the lease terms are stated in the document.
"""


def extract_lease(
    pages: dict[int, str], classifications: list[dict]
) -> dict[str, Any]:
    """Extract lease terms and structure (Pass 3).

    Focuses on lease summary and financial pages.

    Args:
        pages: Full page text mapping.
        classifications: Output from :func:`classify_pages`.

    Returns:
        Dict with ``lease`` and ``confidence`` keys.
    """
    relevant = _filter_pages(
        pages, classifications, _LEASE_PAGE_TYPES
    )
    # Also include rent_roll pages — they often contain lease details
    rent_roll_pages = _filter_pages(
        pages, classifications, {"rent_roll"}
    )
    relevant.update(rent_roll_pages)

    if not relevant:
        # Fallback: use all pages with financial data
        relevant = _filter_pages(
            pages, classifications, set(), require_financial_data=True
        )
    if not relevant:
        # Last resort: send everything
        relevant = pages

    page_text = _format_pages_for_prompt(relevant)

    return _call_anthropic(
        model=MODEL_SONNET,
        system=_LEASE_SYSTEM_PROMPT,
        user_message=(
            "Extract lease terms from these OM pages.\n\n" + page_text
        ),
        max_tokens=4096,
    )


# ---------------------------------------------------------------------------
# Pass 4 — Financial Extraction
# ---------------------------------------------------------------------------

_FINANCIAL_SYSTEM_PROMPT = """\
You are a commercial real estate financial analyst. Extract financial
details from the following pages of an offering memorandum.

Return ONLY valid JSON with the following structure:

{
  "financials_as_stated": {
    "asking_price": <float or null>,
    "asking_cap_rate": <float or null — expressed as decimal, e.g. 0.065 for 6.5%>,
    "asking_price_psf": <float or null>,
    "noi_year1": <float or null>,
    "noi_source": "<in_place|pro_forma|trailing_12|annualized or null>",
    "gross_income": <float or null>,
    "effective_gross_income": <float or null>,
    "vacancy_rate": <float or null — expressed as decimal, e.g. 0.05 for 5%>,
    "operating_expenses": <float or null>,
    "real_estate_taxes": <float or null>,
    "insurance": <float or null>,
    "cam_charges": <float or null>,
    "management_fee": <float or null>,
    "management_fee_percent": <float or null — decimal>,
    "capex_reserves": <float or null>,
    "debt_service": <float or null>,
    "cash_on_cash_return": <float or null — decimal>,
    "irr_projected": <float or null — decimal>,
    "equity_multiple": <float or null>,
    "rent_per_sf": <float or null>,
    "occupancy_rate": <float or null — decimal, e.g. 1.0 for 100%>,
    "calculated_noi_from_rent": <float or null — base_rent minus operating expenses if determinable>,
    "noi_matches_stated": <bool or null — true if calculated NOI roughly matches stated NOI>
  },
  "confidence": {
    "financials": <float 0.0-1.0>
  }
}

Rules:
- Use null for any field you cannot determine with reasonable confidence.
- All percentages/rates should be expressed as decimals (0.065 not 6.5).
- asking_cap_rate = noi_year1 / asking_price. If you can compute this but
  the OM states a different cap rate, include the stated value and note
  the discrepancy via noi_matches_stated.
- Cross-validate: if you can calculate NOI from (rent - expenses), put it
  in calculated_noi_from_rent and compare to the stated noi_year1.
- confidence reflects how clearly the financials are stated and how
  internally consistent they are.
"""


def extract_financials(
    pages: dict[int, str], classifications: list[dict]
) -> dict[str, Any]:
    """Extract financial metrics and validate internal consistency (Pass 4).

    Focuses on pages classified as financial or flagged as containing
    financial data.

    Args:
        pages: Full page text mapping.
        classifications: Output from :func:`classify_pages`.

    Returns:
        Dict with ``financials_as_stated`` and ``confidence`` keys.
    """
    relevant = _filter_pages(
        pages, classifications, _FINANCIAL_PAGE_TYPES
    )
    # Also grab anything with financial data regardless of type
    fin_data_pages = _filter_pages(
        pages, classifications, set(), require_financial_data=True
    )
    relevant.update(fin_data_pages)

    if not relevant:
        # Fallback: all pages
        relevant = pages

    page_text = _format_pages_for_prompt(relevant)

    return _call_anthropic(
        model=MODEL_SONNET,
        system=_FINANCIAL_SYSTEM_PROMPT,
        user_message=(
            "Extract financial details from these OM pages.\n\n" + page_text
        ),
        max_tokens=4096,
    )


# ---------------------------------------------------------------------------
# Pass 5 — Reconciliation
# ---------------------------------------------------------------------------


def reconcile(
    property_tenant: dict[str, Any],
    lease: dict[str, Any],
    financials: dict[str, Any],
) -> dict[str, Any]:
    """Merge extraction results into a canonical DealSchema and detect conflicts.

    This is a pure-logic pass — no LLM calls. It merges the three extraction
    dicts, identifies conflicts between stated vs. calculated values, and
    flags missing critical fields.

    Args:
        property_tenant: Output from :func:`extract_property_tenant`.
        lease: Output from :func:`extract_lease`.
        financials: Output from :func:`extract_financials`.

    Returns:
        Dict with ``deal_schema``, ``conflicts``, ``missing_critical_fields``,
        and ``human_review_required`` keys.
    """
    # ---- Build unified deal schema ----
    deal_schema: dict[str, Any] = {
        "property": property_tenant.get("property", {}),
        "tenant": property_tenant.get("tenant", {}),
        "lease": lease.get("lease", {}),
        "financials_as_stated": financials.get("financials_as_stated", {}),
        "confidence": {},
    }

    # Merge confidence scores
    for source in (property_tenant, lease, financials):
        if "confidence" in source and isinstance(source["confidence"], dict):
            deal_schema["confidence"].update(source["confidence"])

    # ---- Conflict detection ----
    conflicts: list[dict[str, Any]] = []
    fin = deal_schema.get("financials_as_stated", {})
    lease_data = deal_schema.get("lease", {})

    # Check 1: Stated NOI vs. calculated NOI from rent
    stated_noi = fin.get("noi_year1")
    calc_noi = fin.get("calculated_noi_from_rent")
    if stated_noi is not None and calc_noi is not None:
        if stated_noi > 0:
            diff_pct = abs(stated_noi - calc_noi) / stated_noi
            if diff_pct > 0.05:  # more than 5% discrepancy
                conflicts.append({
                    "field": "noi_year1",
                    "type": "value_mismatch",
                    "stated": stated_noi,
                    "calculated": calc_noi,
                    "difference_pct": round(diff_pct * 100, 2),
                    "message": (
                        f"Stated NOI (${stated_noi:,.0f}) differs from "
                        f"calculated NOI (${calc_noi:,.0f}) by "
                        f"{diff_pct * 100:.1f}%"
                    ),
                })

    # Check 2: Cap rate consistency (cap_rate = NOI / price)
    asking_price = fin.get("asking_price")
    asking_cap = fin.get("asking_cap_rate")
    if asking_price and stated_noi and asking_cap:
        computed_cap = stated_noi / asking_price
        cap_diff = abs(asking_cap - computed_cap)
        if cap_diff > 0.005:  # more than 50 bps
            conflicts.append({
                "field": "asking_cap_rate",
                "type": "calculation_mismatch",
                "stated": asking_cap,
                "calculated": round(computed_cap, 4),
                "message": (
                    f"Stated cap rate ({asking_cap:.2%}) does not match "
                    f"NOI/Price ({computed_cap:.2%})"
                ),
            })

    # Check 3: Lease rent vs. financial rent
    lease_rent = lease_data.get("base_rent_annual")
    fin_rent_psf = fin.get("rent_per_sf")
    prop_sqft = deal_schema.get("property", {}).get("building_square_footage")
    if lease_rent and fin_rent_psf and prop_sqft:
        implied_rent = fin_rent_psf * prop_sqft
        if lease_rent > 0:
            rent_diff = abs(lease_rent - implied_rent) / lease_rent
            if rent_diff > 0.05:
                conflicts.append({
                    "field": "base_rent_annual",
                    "type": "cross_source_mismatch",
                    "lease_stated": lease_rent,
                    "financial_implied": round(implied_rent, 2),
                    "difference_pct": round(rent_diff * 100, 2),
                    "message": (
                        f"Lease-stated annual rent (${lease_rent:,.0f}) differs "
                        f"from financials-implied rent (${implied_rent:,.0f})"
                    ),
                })

    # ---- Missing critical fields ----
    missing: list[str] = []
    for dotted_key in _CRITICAL_FIELDS:
        value = _nested_get(deal_schema, dotted_key)
        if value is None:
            missing.append(dotted_key)

    # ---- Human review decision ----
    min_confidence = min(
        deal_schema["confidence"].get("property", 0.0),
        deal_schema["confidence"].get("tenant", 0.0),
        deal_schema["confidence"].get("lease", 0.0),
        deal_schema["confidence"].get("financials", 0.0),
    )

    human_review_required = (
        len(conflicts) > 0
        or len(missing) >= 3
        or min_confidence < 0.6
    )

    return {
        "deal_schema": deal_schema,
        "conflicts": conflicts,
        "missing_critical_fields": missing,
        "human_review_required": human_review_required,
    }


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------


def run_extraction(pages: dict[int, str]) -> dict[str, Any]:
    """Run the full 5-pass extraction pipeline.

    Args:
        pages: Mapping of page number (1-indexed) to extracted text content.

    Returns:
        Reconciled deal schema with conflicts and review flags. Structure::

            {
                "deal_schema": { ... },
                "conflicts": [ ... ],
                "missing_critical_fields": [ ... ],
                "human_review_required": bool,
                "metadata": {
                    "total_pages": int,
                    "classifications": [ ... ],
                    "extraction_time_seconds": float,
                }
            }
    """
    start_time = time.time()

    if not pages:
        return {
            "deal_schema": {},
            "conflicts": [],
            "missing_critical_fields": list(_CRITICAL_FIELDS),
            "human_review_required": True,
            "metadata": {
                "total_pages": 0,
                "classifications": [],
                "extraction_time_seconds": 0.0,
            },
        }

    # Pass 1 — Classification (sequential, must complete before passes 2-4)
    logger.info("Pass 1: Classifying %d pages", len(pages))
    classifications = classify_pages(pages)

    # Passes 2-4 — run in parallel
    logger.info("Passes 2-4: Extracting property/tenant, lease, financials")

    property_tenant_result: dict[str, Any] = {}
    lease_result: dict[str, Any] = {}
    financials_result: dict[str, Any] = {}
    errors: list[str] = []

    with ThreadPoolExecutor(max_workers=3) as executor:
        future_to_name = {
            executor.submit(
                extract_property_tenant, pages, classifications
            ): "property_tenant",
            executor.submit(
                extract_lease, pages, classifications
            ): "lease",
            executor.submit(
                extract_financials, pages, classifications
            ): "financials",
        }

        for future in as_completed(future_to_name):
            name = future_to_name[future]
            try:
                result = future.result()
                if name == "property_tenant":
                    property_tenant_result = result
                elif name == "lease":
                    lease_result = result
                elif name == "financials":
                    financials_result = result
            except Exception as exc:
                logger.error("Pass '%s' failed: %s", name, exc, exc_info=True)
                errors.append(f"{name}: {exc}")

    # Pass 5 — Reconciliation
    logger.info("Pass 5: Reconciling results")
    reconciled = reconcile(property_tenant_result, lease_result, financials_result)

    # Attach metadata
    elapsed = time.time() - start_time
    reconciled["metadata"] = {
        "total_pages": len(pages),
        "classifications": classifications,
        "extraction_time_seconds": round(elapsed, 2),
    }

    if errors:
        reconciled["extraction_errors"] = errors
        reconciled["human_review_required"] = True

    logger.info(
        "Extraction complete in %.1fs — %d conflicts, %d missing fields, review=%s",
        elapsed,
        len(reconciled["conflicts"]),
        len(reconciled["missing_critical_fields"]),
        reconciled["human_review_required"],
    )

    return reconciled
