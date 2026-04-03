# Slop — AI-Powered CRE Underwriting

Slop is a commercial real estate underwriting platform that automates the analysis of net-lease and multi-tenant investment deals. Upload an offering memorandum, and Slop extracts key data, runs a full ARGUS-style underwriting engine, and produces institutional-grade pro forma output.

## Features

- **Smart Document Upload** — PDF ingestion with automatic property identification and matching
- **5-Pass LLM Extraction** — Extracts property, tenant, lease, and financial data from OMs
- **Human Review Stage** — Editable extracted data with flagged fields before underwriting
- **Multi-Tenant Rent Roll** — Per-tenant schedules with weighted average lease term (WALT)
- **ARGUS-Style Re-Leasing** — Renewal probability blending, downtime months, TI/LC costs
- **Debt Modeling** — LTV + DSCR-constrained loan sizing with IO periods and amortization
- **DSCR Tracking** — Per-year debt service coverage with covenant breach flags
- **Market Rent Growth** — Compound annual growth applied to releasing rents
- **Expense Reimbursements** — CAM/tax/insurance recovery modeling (NNN/NN/Gross)
- **Absorption & Lease-Up** — Vacant suite modeling with prorated revenue ramp
- **Scheduled CapEx** — One-time capital expenditure events alongside annual reserves
- **Sensitivity Analysis** — Hold period x exit cap rate grid with heat-mapped IRR/EM (unleveraged + leveraged)
- **Risk Scoring** — 15 automated risk flags across credit, lease, market, and financial dimensions
- **Pricing Engine** — Target, walk-away, and upside price recommendations
- **Pro Forma Viewer** — Full operating statement, exit analysis, scenario cards, and pricing summary

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16 (App Router), Tailwind CSS v4, TypeScript |
| Backend | FastAPI (Python), Uvicorn |
| Database | Supabase (PostgreSQL + Storage) |
| AI/ML | LLM-powered extraction pipeline |
| UI | lucide-react icons, sonner toasts, custom components |

## Getting Started

### Prerequisites

- Node.js 18+
- Python 3.11+
- Supabase project (or local Supabase instance)

### Setup

```bash
# Install frontend dependencies
npm install

# Set up Python virtual environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Configure environment
cp .env.example .env.local
# Edit .env.local with your Supabase URL and keys
```

### Development

Run both servers concurrently:

```bash
# Terminal 1 — Next.js frontend
npm run dev

# Terminal 2 — FastAPI backend
.venv/bin/python3 -m uvicorn api.main:app --reload --port 8000
```

The app runs at `http://localhost:3000`. The API is accessible at `http://localhost:8000`.

## Deal Pipeline

Each deal progresses through a status pipeline:

```
Upload → Extract → Review → Underwrite → Complete
```

1. **Upload** — Drop PDF documents (OMs, rent rolls, leases)
2. **Extract** — LLM processes documents in 5 passes to build a structured deal schema
3. **Review** — Edit extracted data, set underwriting assumptions (hold period, exit cap, debt, etc.)
4. **Underwrite** — Engine runs rent schedule, cash flow, exit analysis, sensitivity, risk scoring
5. **Complete** — View results, pro forma, risk flags, and recommendations (Go / Watch / Pass)

## Project Structure

```
api/
  main.py                    # FastAPI routes
  underwriting/engine.py     # Core math engine
  extraction/                # PDF parsing + LLM extraction
src/
  app/                       # Next.js App Router pages
  components/                # Shared UI components
  lib/
    types.ts                 # TypeScript interfaces
    supabase.ts              # Supabase client
    utils.ts                 # Formatting helpers
```

## License

ISC
