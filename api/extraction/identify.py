"""
Quick-read identification pass: extracts just enough from page 1 of a PDF
to identify which property it belongs to (address, tenant name, property type).
Uses Haiku for speed — this needs to feel instant.
"""

import json
import logging
from anthropic import Anthropic
from api.shared.supabase_client import ANTHROPIC_API_KEY

logger = logging.getLogger(__name__)

client = Anthropic(api_key=ANTHROPIC_API_KEY)

IDENTIFY_PROMPT = """You are a commercial real estate document analyst.
Read the first page(s) of this document and extract ONLY these identification fields.
Return ONLY valid JSON — no markdown, no explanation.

{
  "document_type": "om" | "rent_roll" | "financial_statement" | "lease" | "other",
  "property_address": "full street address or null",
  "city": "city or null",
  "state": "two-letter state code or null",
  "tenant_name": "primary tenant name or null",
  "property_name": "property/deal name from the cover page or null",
  "property_type": "QSR" | "Pharmacy" | "Dollar" | "Auto" | "C-Store" | "Bank" | "Medical" | "Other" | null,
  "asking_price": number or null,
  "confidence": 0.0 to 1.0
}

If this is a rent roll or financial statement without a cover page, extract whatever you can find.
Use null for anything you cannot determine with reasonable confidence."""


def identify_document(first_pages_text: str) -> dict:
    """
    Quick identification pass on the first 1-2 pages of a document.
    Returns property identity fields for matching against existing properties.
    """
    try:
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=512,
            system="You are a CRE document identification specialist. Return ONLY valid JSON.",
            messages=[
                {
                    "role": "user",
                    "content": f"{IDENTIFY_PROMPT}\n\n--- DOCUMENT TEXT ---\n{first_pages_text[:8000]}",
                }
            ],
        )

        text = response.content[0].text.strip()
        # Strip markdown fences if present
        if text.startswith("```"):
            text = text.split("\n", 1)[1]
            if text.endswith("```"):
                text = text[: text.rfind("```")]
            text = text.strip()

        return json.loads(text)

    except Exception as e:
        logger.error(f"Document identification failed: {e}")
        return {
            "document_type": "other",
            "property_address": None,
            "city": None,
            "state": None,
            "tenant_name": None,
            "property_name": None,
            "property_type": None,
            "asking_price": None,
            "confidence": 0.0,
        }


def match_property(identity: dict, properties: list[dict]) -> dict | None:
    """
    Try to match identified document info against existing properties.
    Returns the best matching property or None.

    Matching strategy (in priority order):
    1. Exact address match (normalized)
    2. Fuzzy address match (street name + city)
    3. Tenant name + city match
    """
    if not properties:
        return None

    addr = (identity.get("property_address") or "").lower().strip()
    city = (identity.get("city") or "").lower().strip()
    tenant = (identity.get("tenant_name") or "").lower().strip()

    if not addr and not tenant:
        return None

    best_match = None
    best_score = 0

    for prop in properties:
        score = 0
        prop_addr = (prop.get("property_address") or "").lower().strip()
        prop_city = (prop.get("city") or "").lower().strip()
        prop_name = (prop.get("name") or "").lower().strip()

        # Exact address match
        if addr and prop_addr and addr == prop_addr:
            score += 100

        # Partial address match (street number + street name)
        elif addr and prop_addr:
            addr_parts = addr.split()
            prop_parts = prop_addr.split()
            if len(addr_parts) >= 2 and len(prop_parts) >= 2:
                if addr_parts[0] == prop_parts[0] and addr_parts[1] == prop_parts[1]:
                    score += 70

        # City match
        if city and prop_city and city == prop_city:
            score += 15

        # Tenant name in property name
        if tenant and prop_name and tenant in prop_name:
            score += 40
        elif tenant and prop_name:
            # Check if any significant word matches
            tenant_words = {w for w in tenant.split() if len(w) > 3}
            name_words = {w for w in prop_name.split() if len(w) > 3}
            if tenant_words & name_words:
                score += 20

        if score > best_score:
            best_score = score
            best_match = prop

    # Require a minimum confidence threshold
    if best_score >= 40:
        return best_match

    return None
