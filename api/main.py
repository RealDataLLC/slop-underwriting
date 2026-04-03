"""
Slop — CRE Underwriting API

FastAPI server handling:
- Smart document upload (identify property from PDF content)
- Extraction pipeline (5-pass LLM extraction)
- Underwriting engine (cash flow, pricing, risk scoring)
"""

import logging
import uuid
from datetime import datetime, timezone

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from api.shared.supabase_client import supabase
from api.extraction.pdf_parser import parse_pdf
from api.extraction.identify import identify_document, match_property
from api.extraction.llm_extractor import run_extraction
from api.underwriting.engine import run_underwriting, build_default_assumptions

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Slop API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Models ───────────────────────────────────────────────────────────────────


class IdentifyResponse(BaseModel):
    """Response from the smart upload identification pass."""
    document_type: str | None
    property_address: str | None
    city: str | None
    state: str | None
    tenant_name: str | None
    property_name: str | None
    property_type: str | None
    asking_price: float | None
    confidence: float
    matched_property: dict | None  # Existing property match, if found
    suggested_name: str | None  # Suggested property name if no match


class CreateDealFromUpload(BaseModel):
    """Request to create a deal from an uploaded file."""
    project_id: str
    property_id: str | None = None  # None = create new property
    property_name: str | None = None  # Required if property_id is None
    property_address: str | None = None
    city: str | None = None
    state: str | None = None
    property_type: str | None = None
    document_type: str = "om"
    storage_key: str  # Already uploaded to Supabase Storage


class AssumptionOverrideRequest(BaseModel):
    """Request to override assumptions and rerun underwriting."""
    hold_period_years: int = 5
    exit_cap_rate_mode: str = "spread_to_entry"
    exit_cap_rate_manual: float | None = None
    exit_cap_rate_spread_bps: float | None = 50
    exit_cap_rate_final: float | None = None
    cost_of_sale_pct: float = 0.015
    vacancy_rate: float = 0.0
    mgmt_fee_pct: float = 0.0
    capex_per_sf: float = 0.0
    # Re-leasing
    releasing: dict | None = None
    # Phase 2: Debt
    debt: dict | None = None  # DebtAssumptions: {loan_enabled, ltv_pct, dscr_constraint, interest_rate, amortization_years, loan_term_years, io_period_years, dscr_covenant}
    # Phase 3: Market Rent Growth + Expense Reimbursements
    market_rent_growth_pct: float | None = None
    expense_reimbursements: dict | None = None  # {cam_psf, tax_psf, insurance_psf, cam_growth_pct, tax_growth_pct, insurance_growth_pct, admin_fee_pct}
    # Phase 4: Absorption
    absorption: dict | None = None  # {enabled, vacant_suites, stabilized_occupancy_pct}
    # Phase 5: Scheduled CapEx
    scheduled_capex: list[dict] | None = None  # [{description, year, cost}]
    # Multi-tenant re-leasing
    releasing_per_tenant: dict | None = None  # {tenant_id: {downtime_months, ...}}


# ─── Smart Upload ─────────────────────────────────────────────────────────────


@app.post("/identify", response_model=IdentifyResponse)
async def identify_upload(
    file: UploadFile = File(...),
    project_id: str = Form(...),
):
    """
    Smart upload: reads the first pages of a PDF to identify which property
    it belongs to. Returns identity info + best matching existing property.
    """
    if not file.filename:
        raise HTTPException(400, "No file provided")

    file_bytes = await file.read()

    # Parse first 2 pages only (speed)
    pages = parse_pdf(file_bytes)
    first_pages_text = "\n\n".join(
        pages[p] for p in sorted(pages.keys())[:2]
    )

    if not first_pages_text.strip():
        raise HTTPException(400, "Could not extract text from document")

    # Run quick identification
    identity = identify_document(first_pages_text)

    # Fetch existing properties for this project
    result = supabase.table("uw_properties").select("*").eq(
        "project_id", project_id
    ).eq("is_archived", False).execute()

    existing_properties = result.data or []

    # Try to match
    matched = match_property(identity, existing_properties)

    # Build suggested name if no match
    suggested_name = None
    if not matched:
        parts = []
        if identity.get("tenant_name"):
            parts.append(identity["tenant_name"])
        if identity.get("city"):
            parts.append(identity["city"])
        elif identity.get("property_address"):
            parts.append(identity["property_address"])
        suggested_name = " — ".join(parts) if parts else identity.get("property_name")

    return IdentifyResponse(
        document_type=identity.get("document_type"),
        property_address=identity.get("property_address"),
        city=identity.get("city"),
        state=identity.get("state"),
        tenant_name=identity.get("tenant_name"),
        property_name=identity.get("property_name"),
        property_type=identity.get("property_type"),
        asking_price=identity.get("asking_price"),
        confidence=identity.get("confidence", 0.0),
        matched_property=matched,
        suggested_name=suggested_name,
    )


@app.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    project_id: str = Form(...),
):
    """
    Upload a file to Supabase Storage and return the storage key.
    Does NOT create a deal yet — that happens after identification.
    """
    if not file.filename:
        raise HTTPException(400, "No file provided")

    file_bytes = await file.read()
    temp_key = f"staging/{uuid.uuid4()}/{file.filename}"

    storage_result = supabase.storage.from_("uw-source-documents").upload(
        temp_key, file_bytes,
        {"content-type": file.content_type or "application/octet-stream"},
    )

    if hasattr(storage_result, "error") and storage_result.error:
        raise HTTPException(500, f"Storage upload failed: {storage_result.error}")

    return {
        "storage_key": temp_key,
        "filename": file.filename,
        "size_bytes": len(file_bytes),
        "mime_type": file.content_type,
    }


@app.post("/deals/create-from-upload")
async def create_deal_from_upload(
    req: CreateDealFromUpload,
    background_tasks: BackgroundTasks,
):
    """
    Create a deal (and optionally a new property) from an uploaded file,
    then kick off extraction in the background.
    """
    property_id = req.property_id

    # Create property if needed
    if not property_id:
        if not req.property_name:
            raise HTTPException(400, "property_name required when creating new property")

        prop_result = supabase.table("uw_properties").insert({
            "project_id": req.project_id,
            "name": req.property_name,
            "property_address": req.property_address,
            "city": req.city,
            "state": req.state,
            "property_type": req.property_type,
            "created_by": None,
            "is_archived": False,
        }).execute()

        property_id = prop_result.data[0]["id"]

    # Create deal
    deal_result = supabase.table("uw_deals").insert({
        "property_id": property_id,
        "status": "extracting",
        "human_review_required": False,
        "created_by": None,
        "label": f"Upload — {datetime.now(timezone.utc).strftime('%b %d, %Y')}",
    }).execute()

    deal_id = deal_result.data[0]["id"]

    # Move file from staging to final path
    final_key = f"{property_id}/{deal_id}/{req.storage_key.split('/')[-1]}"
    # Copy the file to final location
    file_data = supabase.storage.from_("uw-source-documents").download(req.storage_key)
    supabase.storage.from_("uw-source-documents").upload(
        final_key, file_data,
        {"content-type": "application/pdf"},
    )
    # Remove staging file
    supabase.storage.from_("uw-source-documents").remove([req.storage_key])

    # Create document record
    supabase.table("uw_documents").insert({
        "deal_id": deal_id,
        "document_type": req.document_type,
        "original_filename": req.storage_key.split("/")[-1],
        "storage_key": final_key,
        "extraction_status": "pending",
    }).execute()

    # Kick off extraction in background
    background_tasks.add_task(
        _run_extraction_pipeline, deal_id, property_id, final_key
    )

    return {
        "deal_id": deal_id,
        "property_id": property_id,
        "status": "extracting",
    }


# ─── Extraction Pipeline ─────────────────────────────────────────────────────


@app.post("/deals/{deal_id}/extract")
async def trigger_extraction(deal_id: str, background_tasks: BackgroundTasks):
    """Manually trigger extraction on a deal."""
    deal = supabase.table("uw_deals").select("*").eq("id", deal_id).single().execute()
    if not deal.data:
        raise HTTPException(404, "Deal not found")

    docs = supabase.table("uw_documents").select("*").eq("deal_id", deal_id).execute()
    if not docs.data:
        raise HTTPException(400, "No documents uploaded for this deal")

    # Update status
    supabase.table("uw_deals").update({"status": "extracting"}).eq("id", deal_id).execute()

    property_id = deal.data["property_id"]
    storage_key = docs.data[0]["storage_key"]

    background_tasks.add_task(_run_extraction_pipeline, deal_id, property_id, storage_key)

    return {"status": "extracting", "deal_id": deal_id}


async def _run_extraction_pipeline(deal_id: str, property_id: str, storage_key: str):
    """Background task: run the full extraction pipeline."""
    try:
        logger.info(f"Starting extraction for deal {deal_id}")

        # Download file from storage
        file_bytes = supabase.storage.from_("uw-source-documents").download(storage_key)

        # Parse PDF
        pages = parse_pdf(file_bytes)
        if not pages:
            raise ValueError("PDF parsing returned no pages")

        # Update document status
        supabase.table("uw_documents").update({
            "extraction_status": "running",
        }).eq("storage_key", storage_key).execute()

        # Run 5-pass extraction
        result = run_extraction(pages)

        deal_schema = result.get("deal_schema", {})
        conflicts = result.get("conflicts", [])
        human_review = result.get("human_review_required", False)

        # Update document with extraction results
        supabase.table("uw_documents").update({
            "extraction_status": "complete",
            "extracted_at": datetime.now(timezone.utc).isoformat(),
            "extraction_confidence": result.get("deal_schema", {}).get(
                "extraction_metadata", {}
            ).get("confidence_scores"),
            "page_classification": result.get("classifications"),
            "raw_extraction": result.get("deal_schema"),
        }).eq("storage_key", storage_key).execute()

        # Determine next status
        next_status = "review" if human_review else "underwriting"

        # Update deal with extracted schema
        supabase.table("uw_deals").update({
            "status": next_status,
            "deal_schema": deal_schema,
            "human_review_required": human_review,
            "review_summary": (
                f"{len(conflicts)} conflict(s) found. "
                + "; ".join(c.get("description", "") for c in conflicts[:3])
                if conflicts else None
            ),
        }).eq("id", deal_id).execute()

        logger.info(f"Extraction complete for deal {deal_id}: status={next_status}")

        # If no review needed, auto-run underwriting
        if not human_review:
            await _run_underwriting_pipeline(deal_id)

    except Exception as e:
        logger.error(f"Extraction failed for deal {deal_id}: {e}")
        supabase.table("uw_deals").update({
            "status": "review",
            "human_review_required": True,
            "review_summary": f"Extraction error: {str(e)}",
        }).eq("id", deal_id).execute()
        supabase.table("uw_documents").update({
            "extraction_status": "failed",
            "extraction_error": str(e),
        }).eq("storage_key", storage_key).execute()


# ─── Underwriting Pipeline ────────────────────────────────────────────────────


@app.post("/deals/{deal_id}/underwrite")
async def trigger_underwriting(deal_id: str, background_tasks: BackgroundTasks):
    """Manually trigger underwriting on a deal."""
    deal = supabase.table("uw_deals").select("*").eq("id", deal_id).single().execute()
    if not deal.data:
        raise HTTPException(404, "Deal not found")

    if not deal.data.get("deal_schema"):
        raise HTTPException(400, "Deal has no extracted data — run extraction first")

    supabase.table("uw_deals").update({"status": "underwriting"}).eq("id", deal_id).execute()
    background_tasks.add_task(_run_underwriting_pipeline, deal_id)

    return {"status": "underwriting", "deal_id": deal_id}


async def _run_underwriting_pipeline(deal_id: str):
    """Background task: run the underwriting engine."""
    try:
        logger.info(f"Starting underwriting for deal {deal_id}")

        # Fetch deal + project target params
        deal = supabase.table("uw_deals").select("*").eq("id", deal_id).single().execute()
        deal_data = deal.data
        deal_schema = deal_data["deal_schema"]

        # Get project's target parameters
        prop = supabase.table("uw_properties").select("project_id").eq(
            "id", deal_data["property_id"]
        ).single().execute()
        project = supabase.table("uw_projects").select("*").eq(
            "id", prop.data["project_id"]
        ).single().execute()

        # Build assumptions (use overrides if they exist, else defaults)
        overrides = deal_data.get("assumption_overrides")
        if overrides:
            assumptions = overrides
        else:
            assumptions = build_default_assumptions(deal_schema)

            # Apply project-level targets if set
            proj = project.data
            if proj.get("target_cap_rate"):
                assumptions["scenarios"]["base"]["exit_cap_rate"] = (
                    proj["target_cap_rate"] + assumptions.get("exit_cap_rate_spread_bps", 50) / 10000
                )
            if proj.get("target_irr"):
                assumptions["target_irr"] = proj["target_irr"]

        # Run the engine
        output = run_underwriting(deal_schema, assumptions)

        # Map engine output keys to DB column names
        risk_data = output.get("risk", {})
        rec_data = output.get("recommendation", {})
        recommendation_str = rec_data.get("recommendation", "watch") if isinstance(rec_data, dict) else rec_data
        rationale_str = rec_data.get("rationale", "") if isinstance(rec_data, dict) else ""

        # Write version row
        supabase.table("uw_versions").insert({
            "deal_id": deal_id,
            "created_by": None,
            "trigger": "initial" if not overrides else "assumption_override",
            "assumptions": assumptions,
            "rent_schedule": output.get("rent_schedule"),
            "cash_flow_model": output.get("cash_flow"),
            "exit_analysis": output.get("exit_analysis"),
            "sensitivity_grid": output.get("sensitivity_grid"),
            "pricing_output": output.get("pricing"),
            "risk_score": risk_data.get("risk_score") if isinstance(risk_data, dict) else None,
            "risk_flags": risk_data.get("risk_flags", []) if isinstance(risk_data, dict) else [],
            "recommendation": recommendation_str,
            "debt_schedule": output.get("debt_schedule"),
            "debt_summary": output.get("debt_summary"),
        }).execute()

        # Build a normalized output for the deal record
        pricing_output = output.get("pricing", {})
        normalized_output = {
            "assumptions": output.get("assumptions"),
            "rent_schedule": output.get("rent_schedule"),
            "cash_flow": output.get("cash_flow"),
            "exit_analysis": output.get("exit_analysis"),
            "sensitivity_grid": output.get("sensitivity_grid"),
            "pricing_output": pricing_output,
            "risk_score": risk_data.get("risk_score") if isinstance(risk_data, dict) else None,
            "risk_flags": risk_data.get("risk_flags", []) if isinstance(risk_data, dict) else [],
            "recommendation": recommendation_str,
            "summary": output.get("summary"),
            "debt_schedule": output.get("debt_schedule"),
            "debt_summary": output.get("debt_summary"),
            "walt": output.get("walt"),
            "tenant_count": output.get("tenant_count"),
        }

        # Update deal
        supabase.table("uw_deals").update({
            "status": "complete",
            "underwriting_output": normalized_output,
            "recommendation": recommendation_str,
            "recommendation_rationale": rationale_str,
            "risk_score": risk_data.get("risk_score") if isinstance(risk_data, dict) else None,
        }).eq("id", deal_id).execute()

        logger.info(
            f"Underwriting complete for deal {deal_id}: "
            f"recommendation={recommendation_str}, risk={risk_data.get('risk_score')}"
        )

    except Exception as e:
        import traceback
        logger.error(f"Underwriting failed for deal {deal_id}: {e}\n{traceback.format_exc()}")
        supabase.table("uw_deals").update({
            "status": "review",
            "review_summary": f"Underwriting error: {str(e)}",
        }).eq("id", deal_id).execute()


# ─── Assumption Override ──────────────────────────────────────────────────────


@app.put("/deals/{deal_id}/assumptions")
async def override_assumptions(
    deal_id: str,
    req: AssumptionOverrideRequest,
    background_tasks: BackgroundTasks,
):
    """Override assumptions and trigger a new underwriting run."""
    deal = supabase.table("uw_deals").select("*").eq("id", deal_id).single().execute()
    if not deal.data:
        raise HTTPException(404, "Deal not found")
    if not deal.data.get("deal_schema"):
        raise HTTPException(400, "No deal schema — run extraction first")

    assumptions = req.model_dump()

    # Compute final exit cap rate
    deal_schema = deal.data["deal_schema"]
    asking_cap = (
        deal_schema.get("financials_as_stated", {}).get("asking_cap_rate") or 0.065
    )

    if req.exit_cap_rate_mode == "manual" and req.exit_cap_rate_manual:
        assumptions["exit_cap_rate_final"] = req.exit_cap_rate_manual
    elif req.exit_cap_rate_mode == "spread_to_entry" and req.exit_cap_rate_spread_bps:
        assumptions["exit_cap_rate_final"] = asking_cap + (req.exit_cap_rate_spread_bps / 10000)
    else:
        assumptions["exit_cap_rate_final"] = asking_cap + 0.005

    # Add scenario defaults
    spread = assumptions.get("exit_cap_rate_spread_bps", 50) or 50
    assumptions["scenarios"] = {
        "bear": {
            "exit_cap_rate": assumptions["exit_cap_rate_final"] + 0.005,
            "hold_period_years": req.hold_period_years,
        },
        "base": {
            "exit_cap_rate": assumptions["exit_cap_rate_final"],
            "hold_period_years": req.hold_period_years,
        },
        "bull": {
            "exit_cap_rate": assumptions["exit_cap_rate_final"] - 0.005,
            "hold_period_years": req.hold_period_years,
        },
    }
    assumptions["reversion_noi_method"] = "forward_year"

    # Save overrides
    supabase.table("uw_deals").update({
        "assumption_overrides": assumptions,
        "status": "underwriting",
    }).eq("id", deal_id).execute()

    # Rerun underwriting
    background_tasks.add_task(_run_underwriting_pipeline, deal_id)

    return {"status": "underwriting", "deal_id": deal_id}


# ─── Deal Status ──────────────────────────────────────────────────────────────


@app.get("/deals/{deal_id}/status")
async def get_deal_status(deal_id: str):
    """Poll deal status (used by frontend while extraction/underwriting runs)."""
    deal = supabase.table("uw_deals").select(
        "id, status, recommendation, risk_score, human_review_required, review_summary"
    ).eq("id", deal_id).single().execute()

    if not deal.data:
        raise HTTPException(404, "Deal not found")

    return deal.data


# ─── Health ───────────────────────────────────────────────────────────────────


@app.get("/health")
async def health():
    return {"status": "ok", "service": "slop-api"}
