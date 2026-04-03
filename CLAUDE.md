# Slop — AI-Powered CRE Underwriting Platform

## Project Overview

Slop is a commercial real estate (CRE) underwriting platform that automates deal analysis. It ingests offering memorandums (OMs) and other deal documents, extracts key data via LLM, runs a full underwriting engine, and produces ARGUS Enterprise-style pro forma output.

## Architecture

- **Frontend**: Next.js 16 (App Router) + Tailwind CSS v4 + shadcn-inspired components + lucide-react icons + sonner toasts
- **Backend**: FastAPI (Python) proxied at `/api/py/*`, also accessible directly at `http://127.0.0.1:8000`
- **Database**: Supabase (PostgreSQL + Storage), project ID `loqriakpdmmcstnnkqtb`
- **Untyped Supabase client**: We use an untyped client and cast at the call site (see `src/lib/types.ts`)

## Dev Servers

Both servers must run concurrently. Configured in `.claude/launch.json`:
- **Next.js**: `npm run dev` on port 3000
- **FastAPI**: `.venv/bin/python3 -m uvicorn api.main:app --reload --port 8000` on port 8000

## Key Directories

```
api/                        # Python backend
  main.py                   # FastAPI routes (upload, extract, underwrite, assumptions)
  underwriting/engine.py    # Core math engine (rent schedule, cash flow, exit, sensitivity, debt, risk)
  extraction/               # PDF parsing + LLM extraction pipeline
  shared/supabase_client.py # Supabase Python client

src/                        # Next.js frontend
  app/                      # App Router pages
    projects/[projectId]/properties/[propertyId]/deals/[dealId]/
      page.tsx              # Deal page (upload → extract → review → underwrite → complete)
      proforma/page.tsx     # Pro forma viewer (operating statement, exit, sensitivity, pricing)
  components/               # Shared UI components
    deals/                  # Deal-specific components (status-pipeline, upload-zone)
    layout/                 # Shell, navigation
    ui/                     # Badge, buttons, etc.
  lib/
    types.ts                # All TypeScript interfaces (mirrors Python engine output)
    supabase.ts             # Supabase browser client
    utils.ts                # Formatting helpers (formatCurrency, formatPercent, etc.)
```

## Database Tables

- `uw_projects` — Portfolio/project grouping
- `uw_properties` — Individual properties
- `uw_deals` — Deal records (status pipeline: uploading → extracting → review → underwriting → complete)
- `uw_documents` — Uploaded PDFs with extraction status
- `uw_versions` — Versioned underwriting snapshots (assumptions + full output)
- `uw_comps` — Comparable sale transactions

## Underwriting Engine Features (ARGUS-Style)

The engine (`api/underwriting/engine.py`) supports:
1. **Multi-tenant rent roll** — Per-tenant schedules with WALT calculation
2. **ARGUS re-leasing model** — Renewal probability blending, downtime, TI/LC costs
3. **Debt modeling** — LTV + DSCR-constrained loan sizing, IO periods, amortization
4. **DSCR tracking** — Per-year covenant monitoring with risk flags
5. **Market rent growth** — Compound annual growth applied to re-leasing rents
6. **Expense reimbursements** — CAM/tax/insurance with NNN/NN/Gross recovery rates
7. **Absorption/lease-up** — Vacant suite modeling with prorated ramp
8. **Scheduled CapEx** — Lumpy capital events alongside annual reserves
9. **Sensitivity grid** — Hold period x exit cap rate matrix (unleveraged + leveraged)
10. **Risk scoring** — 15 automated risk flags with severity levels
11. **Pricing output** — Target, walk-away, and upside prices

## Conventions

- Cap rates display with 1 decimal point (e.g., `6.5%`)
- All assumption percentage inputs use `step={0.1}` and display with 1 decimal
- Engine stores percentages as decimals (0.065), frontend converts to display format (6.5)
- `gla_sf` field has fallback to `building_square_footage` for extraction compatibility
- Rent bumps are filtered to future-only (no historical re-application)

## Common Commands

```bash
# Type check
npx tsc --noEmit

# Verify engine imports
.venv/bin/python3 -c "from api.underwriting.engine import run_underwriting"

# Dev servers (handled by .claude/launch.json)
npm run dev
.venv/bin/python3 -m uvicorn api.main:app --reload --port 8000
```
