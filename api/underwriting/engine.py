"""
Slop CRE Underwriting Engine
============================

Pure-math underwriting engine for commercial real estate net-lease deals.
Takes a canonical deal schema (extracted data) and assumption overrides,
produces the full underwriting output including rent schedule, cash flow
projections, exit analysis, sensitivity grids, pricing, risk scoring,
and investment recommendation.

All monetary values are in USD. All rates are decimals (0.065 = 6.5%).
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Optional


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_float(val: Any, default: float = 0.0) -> float:
    """Coerce a value to float, returning *default* on failure."""
    if val is None:
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _safe_div(numerator: float, denominator: float, default: float = 0.0) -> float:
    """Division guarded against zero / near-zero denominators."""
    if abs(denominator) < 1e-12:
        return default
    return numerator / denominator


def _years_between(date_str: str, ref_date: Optional[str] = None) -> float:
    """Return fractional years between *ref_date* (default today) and *date_str*.

    Positive means *date_str* is in the future.
    """
    try:
        target = datetime.strptime(date_str, "%Y-%m-%d")
    except (ValueError, TypeError):
        return 0.0
    ref = datetime.now() if ref_date is None else datetime.strptime(ref_date, "%Y-%m-%d")
    delta = (target - ref).days / 365.25
    return delta


def _apply_bump(current_rent: float, bump: dict) -> tuple[float, str]:
    """Apply a single rent bump and return (new_rent, description)."""
    bump_type = (bump.get("bump_type") or "").lower().strip()
    bump_value = _safe_float(bump.get("bump_value"))
    new_annual = _safe_float(bump.get("new_annual_rent") or bump.get("new_rent_annual"))

    # If an explicit new annual rent is provided, use it directly
    if new_annual > 0:
        desc = f"Step to ${new_annual:,.0f}"
        return new_annual, desc

    if "flat" in bump_type or "dollar" in bump_type:
        new_rent = current_rent + bump_value
        desc = f"+${bump_value:,.0f} flat"
    elif "cpi" in bump_type:
        pct = bump_value if bump_value < 1 else bump_value / 100
        new_rent = current_rent * (1 + pct)
        desc = f"+{pct:.1%} CPI"
    elif "fix" in bump_type or "pct" in bump_type or "percent" in bump_type:
        pct = bump_value if bump_value < 1 else bump_value / 100
        new_rent = current_rent * (1 + pct)
        desc = f"+{pct:.1%} fixed"
    else:
        # Unknown type — treat as percentage if < 1, dollar amount otherwise
        if 0 < bump_value < 1:
            new_rent = current_rent * (1 + bump_value)
            desc = f"+{bump_value:.1%}"
        elif bump_value >= 1:
            new_rent = current_rent + bump_value
            desc = f"+${bump_value:,.0f}"
        else:
            new_rent = current_rent
            desc = ""

    return round(new_rent, 2), desc


# ---------------------------------------------------------------------------
# Phase 1: Multi-Tenant Rent Roll — Normalize tenants
# ---------------------------------------------------------------------------

def _normalize_tenants(deal_schema: dict) -> list[dict]:
    """Convert deal_schema into a list of tenant entries.

    If deal_schema has 'tenants' array, use it. Otherwise synthesize from
    legacy single tenant+lease with id='primary' and gla_sf from property.
    """
    tenants = deal_schema.get("tenants")
    if tenants and isinstance(tenants, list) and len(tenants) > 0:
        return tenants

    # Synthesize from legacy single-tenant schema
    tenant_info = deal_schema.get("tenant", {})
    lease_info = deal_schema.get("lease", {})
    prop = deal_schema.get("property", {})
    gla_sf = _safe_float(prop.get("gla_sf") or prop.get("building_square_footage"), 0.0)

    return [{
        "id": "primary",
        "name": tenant_info.get("name", "Unknown"),
        "gla_sf": gla_sf,
        "lease": lease_info,
        "tenant": tenant_info,
    }]


# ---------------------------------------------------------------------------
# Default assumptions builder
# ---------------------------------------------------------------------------

def build_default_assumptions(deal_schema: dict) -> dict:
    """Generate sensible underwriting assumptions from the deal data.

    Returns a dict of assumptions that can be overridden by the user before
    being fed into ``run_underwriting``.
    """
    lease = deal_schema.get("lease", {})
    financials = deal_schema.get("financials_as_stated", {})
    prop = deal_schema.get("property", {})

    lease_type = (lease.get("type") or "NNN").upper()
    is_nnn = lease_type in ("NNN", "ABSOLUTE NNN", "TRIPLE NET")
    is_absolute_nnn = bool(lease.get("is_absolute_nnn", False))
    is_nn = lease_type in ("NN", "DOUBLE NET")

    asking_cap = _safe_float(financials.get("asking_cap_rate"), 0.065)

    # Vacancy: 0 during primary term for credit tenants, small buffer otherwise
    vacancy_during_term = 0.0
    vacancy_after_term = 0.05  # 5% after lease expiry

    # Management fee depends on lease structure
    if is_nnn or is_absolute_nnn:
        mgmt_fee_pct = 0.0
    elif is_nn:
        mgmt_fee_pct = 0.02
    else:
        mgmt_fee_pct = 0.03

    # CapEx reserve
    if is_absolute_nnn:
        capex_per_sf = 0.0
    elif is_nnn:
        capex_per_sf = 0.10
    elif is_nn:
        capex_per_sf = 0.25
    else:
        capex_per_sf = 0.50

    exit_spread_bps = 50  # +50 bps over entry
    exit_cap_final = asking_cap + exit_spread_bps / 10_000

    # Re-leasing assumptions (ARGUS-style)
    base_rent = _safe_float(lease.get("base_rent_annual"))
    gla_sf = _safe_float(prop.get("gla_sf") or prop.get("building_square_footage"), 0.0)
    current_rent_psf = _safe_div(base_rent, gla_sf) if gla_sf else 0.0
    # Default market rent = current rent (user should adjust)
    market_rent_psf = current_rent_psf
    renewal_probability = 0.70  # 70% renewal probability

    # Phase 1: Compute WALT for multi-tenant
    tenants = _normalize_tenants(deal_schema)
    tenant_count = len(tenants)
    if tenant_count > 1:
        total_rent_for_walt = 0.0
        weighted_term_sum = 0.0
        for t in tenants:
            t_lease = t.get("lease", {})
            t_rent = _safe_float(t_lease.get("base_rent_annual"))
            t_remaining = _safe_float(t_lease.get("remaining_term_years"), 0.0)
            total_rent_for_walt += t_rent
            weighted_term_sum += t_remaining * t_rent
        walt = _safe_div(weighted_term_sum, total_rent_for_walt, 0.0)
    else:
        walt = _safe_float(lease.get("remaining_term_years"), 0.0)

    assumptions = {
        "hold_period_years": 5,
        "exit_cap_rate_mode": "spread_to_entry",
        "exit_cap_rate_spread_bps": exit_spread_bps,
        "exit_cap_rate_final": exit_cap_final,
        "cost_of_sale_pct": 0.015,
        "vacancy_rate_during_term": vacancy_during_term,
        "vacancy_rate_after_term": vacancy_after_term,
        "mgmt_fee_pct": mgmt_fee_pct,
        "capex_per_sf": capex_per_sf,
        "lease_type": lease_type,
        "is_nnn": is_nnn,
        "is_absolute_nnn": is_absolute_nnn,
        "asking_cap_rate": asking_cap,
        "gla_sf": gla_sf,
        # Phase 1: Multi-tenant metrics
        "walt": round(walt, 2),
        "tenant_count": tenant_count,
        # Re-leasing (ARGUS-style post-expiry modeling)
        "releasing": {
            "downtime_months": 6,           # vacancy gap after expiry
            "market_rent_psf": round(market_rent_psf, 2),  # re-lease rate
            "renewal_probability": renewal_probability,     # 0-1
            "renewal_rent_bump_pct": 0.0,   # bump on renewal vs expiring rent
            "new_lease_term_years": 5,       # new tenant lease term
            "new_lease_bump_pct": 0.02,      # annual bumps on new lease
            "ti_psf": 5.0 if not (is_nnn or is_absolute_nnn) else 0.0,  # TI allowance
            "lc_pct": 0.04,                 # leasing commission (% of total lease value)
        },
        # Phase 3: Market rent growth
        "market_rent_growth_pct": 0.03,
        # Phase 3: Expense reimbursements (defaults to zero / disabled)
        "expense_reimbursements": {
            "cam_psf": 0,
            "tax_psf": 0,
            "insurance_psf": 0,
            "cam_growth_pct": 0.03,
            "tax_growth_pct": 0.03,
            "insurance_growth_pct": 0.02,
            "admin_fee_pct": 0.0,
        },
        # Phase 2: Debt modeling (disabled by default)
        "debt": {
            "loan_enabled": False,
            "ltv_pct": 0.65,
            "interest_rate": 0.055,
            "amort_years": 30,
            "io_years": 0,
            "dscr_constraint": 1.25,
            "dscr_covenant": 1.20,
        },
        # Phase 4: Absorption (disabled by default)
        "absorption": {
            "enabled": False,
            "vacant_suites": [],
        },
        # Phase 5: Scheduled CapEx (empty by default)
        "scheduled_capex": [],
        # Scenario analysis: bear / base / bull exit cap rates
        "scenarios": {
            "bull": {
                "exit_cap_rate": asking_cap - 0.0025,
                "label": "Bull (entry -25bps)",
            },
            "base": {
                "exit_cap_rate": exit_cap_final,
                "label": f"Base (entry +{exit_spread_bps}bps)",
            },
            "bear": {
                "exit_cap_rate": asking_cap + 0.01,
                "label": "Bear (entry +100bps)",
            },
        },
    }
    return assumptions


# ---------------------------------------------------------------------------
# Phase 1: Single-tenant rent schedule builder (extracted)
# ---------------------------------------------------------------------------

def _build_single_tenant_schedule(
    tenant_entry: dict,
    hold_period_years: int,
    assumptions: dict | None = None,
) -> list[dict]:
    """Build a year-by-year rent schedule for a single tenant.

    Reads lease data from tenant_entry['lease']. Includes tenant_id,
    tenant_name, gla_sf in each output row.

    Uses ARGUS-style re-leasing after primary term + options expire.
    """
    tenant_id = tenant_entry.get("id", "primary")
    tenant_name = tenant_entry.get("name", "Unknown")
    gla_sf = _safe_float(tenant_entry.get("gla_sf"), 0.0)
    lease = tenant_entry.get("lease", {})

    base_rent = _safe_float(lease.get("base_rent_annual"))
    remaining_term = _safe_float(lease.get("remaining_term_years"), 0.0)
    rent_bumps = lease.get("rent_bumps") or []
    options = lease.get("options") or []

    # Re-leasing assumptions
    releasing = (assumptions or {}).get("releasing", {})
    downtime_months = _safe_float(releasing.get("downtime_months"), 6)
    market_rent_psf = _safe_float(releasing.get("market_rent_psf"))
    renewal_prob = _safe_float(releasing.get("renewal_probability"), 0.70)
    renewal_bump_pct = _safe_float(releasing.get("renewal_rent_bump_pct"), 0.0)
    new_lease_term = int(_safe_float(releasing.get("new_lease_term_years"), 5))
    new_lease_bump_pct = _safe_float(releasing.get("new_lease_bump_pct"), 0.02)
    ti_psf = _safe_float(releasing.get("ti_psf"), 0.0)
    lc_pct = _safe_float(releasing.get("lc_pct"), 0.04)

    # Phase 3: Market rent growth
    market_rent_growth_pct = _safe_float((assumptions or {}).get("market_rent_growth_pct"), 0.03)

    # Compute market rent annual from PSF if available
    market_rent_annual = market_rent_psf * gla_sf if (market_rent_psf > 0 and gla_sf > 0) else base_rent

    # Sort bumps by effective date if available
    def _bump_sort_key(b: dict):
        try:
            return datetime.strptime(b.get("effective_date", "9999-12-31"), "%Y-%m-%d")
        except (ValueError, TypeError):
            return datetime.max

    rent_bumps_sorted = sorted(rent_bumps, key=_bump_sort_key)

    # Pre-compute when each bump fires relative to year index
    now = datetime.now()
    bump_by_year: dict[int, dict] = {}
    for bump in rent_bumps_sorted:
        ed = bump.get("effective_date")
        if ed:
            try:
                dt = datetime.strptime(ed, "%Y-%m-%d")
                yr_offset = max(1, round((dt - now).days / 365.25))
                bump_by_year[yr_offset] = bump
            except (ValueError, TypeError):
                pass

    # If bumps have no effective dates but have values, only apply bumps
    # that represent FUTURE rent steps (new_annual_rent > current base_rent).
    if not bump_by_year and rent_bumps_sorted:
        future_bumps = [
            b for b in rent_bumps_sorted
            if _safe_float(b.get("new_annual_rent") or b.get("new_rent_annual")) > base_rent
        ]
        for idx, bump in enumerate(future_bumps):
            yr_offset = idx + 1
            bump_by_year[yr_offset] = bump

    # Determine lease coverage timeline
    primary_term_end = max(0, math.ceil(remaining_term))

    # Build option timeline after primary term
    option_periods: list[dict] = []
    option_start = primary_term_end
    for opt in options:
        opt_term = _safe_float(opt.get("term_years"), 5.0)
        option_periods.append({
            "start": option_start,
            "end": option_start + math.ceil(opt_term),
            "rent_bump_type": opt.get("rent_bump_type", "fixed_pct"),
            "rent_bump_value": _safe_float(opt.get("rent_bump_value"), 0.0),
        })
        option_start += math.ceil(opt_term)

    # Total lease coverage including options
    total_coverage_years = option_start

    schedule: list[dict] = []
    current_rent = base_rent
    expiring_rent = base_rent  # will be set to the rent at lease expiry

    # Track re-lease state
    downtime_years = downtime_months / 12.0

    for yr in range(1, hold_period_years + 1):
        bump_applied = ""
        vacancy_loss = 0.0
        leasing_costs = 0.0
        lease_status = "in_place"

        # Phase 3: Apply compound market rent growth
        market_rent_psf_yr = market_rent_psf * (1 + market_rent_growth_pct) ** (yr - 1)
        market_rent_annual_yr = market_rent_psf_yr * gla_sf if (market_rent_psf_yr > 0 and gla_sf > 0) else base_rent

        # --- During primary term ---
        if yr <= primary_term_end:
            if yr in bump_by_year:
                bump = bump_by_year[yr]
                current_rent, bump_applied = _apply_bump(current_rent, bump)
            expiring_rent = current_rent  # track the rent at expiry

        # --- During option periods ---
        elif yr <= total_coverage_years:
            lease_status = "option_period"
            for opt_p in option_periods:
                if opt_p["start"] < yr <= opt_p["end"]:
                    if yr == opt_p["start"] + 1:
                        current_rent, bump_applied = _apply_bump(
                            current_rent,
                            {
                                "bump_type": opt_p["rent_bump_type"],
                                "bump_value": opt_p["rent_bump_value"],
                            },
                        )
                    break
            expiring_rent = current_rent

        # --- Post-expiry: ARGUS-style re-leasing ---
        else:
            years_past_expiry = yr - total_coverage_years  # 1, 2, 3, ...

            if years_past_expiry <= math.ceil(downtime_years):
                # Downtime period — blended vacancy
                lease_status = "vacant_downtime"

                if years_past_expiry == 1:
                    vacant_fraction = min(downtime_years, 1.0)
                else:
                    elapsed = years_past_expiry - 1
                    vacant_fraction = min(downtime_years - elapsed, 1.0)
                    vacant_fraction = max(0.0, vacant_fraction)

                # Renewal scenario: tenant stays, no downtime
                renewal_rent = expiring_rent * (1 + renewal_bump_pct)
                # New tenant scenario: vacant during downtime, then market rent
                occupied_fraction = 1.0 - vacant_fraction
                new_tenant_rent = market_rent_annual_yr * occupied_fraction

                # Probability-weighted blend
                blended_rent = (renewal_prob * renewal_rent +
                                (1 - renewal_prob) * new_tenant_rent)

                current_rent = round(blended_rent, 2)
                bump_applied = f"Re-lease ({vacant_fraction*100:.0f}% downtime blended)"

                # Leasing costs in the first re-lease year
                if years_past_expiry == 1:
                    renewal_ti = 0.0
                    new_ti = ti_psf * gla_sf
                    blended_ti = renewal_prob * renewal_ti + (1 - renewal_prob) * new_ti

                    new_lease_value = market_rent_annual_yr * new_lease_term
                    renewal_lc = 0.0
                    new_lc = lc_pct * new_lease_value
                    blended_lc = renewal_prob * renewal_lc + (1 - renewal_prob) * new_lc

                    leasing_costs = round(blended_ti + blended_lc, 2)

                lease_status = "releasing"
            else:
                # Stabilized re-lease period
                lease_status = "re_leased"
                re_lease_yr = years_past_expiry - math.ceil(downtime_years)

                renewal_rent = expiring_rent * (1 + renewal_bump_pct)
                new_tenant_base = market_rent_annual_yr
                for _ in range(re_lease_yr):
                    renewal_rent *= (1 + new_lease_bump_pct)
                    new_tenant_base *= (1 + new_lease_bump_pct)

                blended_rent = (renewal_prob * renewal_rent +
                                (1 - renewal_prob) * new_tenant_base)
                current_rent = round(blended_rent, 2)
                if re_lease_yr > 0:
                    bump_applied = f"+{new_lease_bump_pct*100:.1f}% annual bump (re-lease yr {re_lease_yr+1})"
                else:
                    bump_applied = "Re-leased (stabilized)"

        rent_psf = _safe_div(current_rent, gla_sf) if gla_sf else 0.0
        egi = current_rent - vacancy_loss

        schedule.append({
            "year": yr,
            "tenant_id": tenant_id,
            "tenant_name": tenant_name,
            "gla_sf": gla_sf,
            "scheduled_rent": round(current_rent, 2),
            "rent_per_sf": round(rent_psf, 2),
            "market_rent_psf": round(market_rent_psf_yr, 2),
            "bump_applied": bump_applied,
            "vacancy_loss": round(vacancy_loss, 2),
            "effective_gross_income": round(egi, 2),
            "leasing_costs": round(leasing_costs, 2),
            "lease_status": lease_status,
        })

    return schedule


# ---------------------------------------------------------------------------
# Rent schedule (multi-tenant aggregation)
# ---------------------------------------------------------------------------

def build_rent_schedule(
    deal_schema: dict,
    hold_period_years: int,
    gla_sf: float,
    assumptions: dict | None = None,
) -> list[dict]:
    """Build a year-by-year rent schedule for the hold period.

    Loops over _normalize_tenants(), calls _build_single_tenant_schedule()
    per tenant, and aggregates by year.

    Args:
        deal_schema: Canonical deal schema.
        hold_period_years: Number of years to project.
        gla_sf: Gross leasable area in square feet (total).
        assumptions: Full assumptions dict (for re-leasing params).

    Returns:
        List of dicts per year with: year, scheduled_rent, rent_per_sf,
        bump_applied, vacancy_loss, effective_gross_income, leasing_costs,
        lease_status, tenant_details.
    """
    tenants = _normalize_tenants(deal_schema)

    # Build per-tenant schedules
    all_tenant_schedules: list[list[dict]] = []
    for tenant_entry in tenants:
        t_schedule = _build_single_tenant_schedule(tenant_entry, hold_period_years, assumptions)
        all_tenant_schedules.append(t_schedule)

    # Aggregate by year
    schedule: list[dict] = []
    for yr_idx in range(hold_period_years):
        yr = yr_idx + 1
        total_rent = 0.0
        total_vacancy = 0.0
        total_egi = 0.0
        total_leasing = 0.0
        total_gla = 0.0
        statuses = set()
        tenant_details = []

        for t_sched in all_tenant_schedules:
            if yr_idx < len(t_sched):
                row = t_sched[yr_idx]
                total_rent += row["scheduled_rent"]
                total_vacancy += row["vacancy_loss"]
                total_egi += row["effective_gross_income"]
                total_leasing += row["leasing_costs"]
                total_gla += row.get("gla_sf", 0.0)
                statuses.add(row["lease_status"])
                tenant_details.append({
                    "tenant_id": row["tenant_id"],
                    "tenant_name": row["tenant_name"],
                    "gla_sf": row["gla_sf"],
                    "scheduled_rent": row["scheduled_rent"],
                    "rent_per_sf": row["rent_per_sf"],
                    "market_rent_psf": row.get("market_rent_psf", 0.0),
                    "lease_status": row["lease_status"],
                    "bump_applied": row["bump_applied"],
                })

        # Blended rent_per_sf
        blended_rent_psf = _safe_div(total_rent, total_gla) if total_gla > 0 else 0.0

        # Lease status: common or "mixed"
        if len(statuses) == 1:
            agg_status = statuses.pop()
        else:
            agg_status = "mixed"

        # Bump applied: combine or use single
        if len(tenant_details) == 1:
            bump_desc = tenant_details[0]["bump_applied"]
        else:
            bump_descs = [d["bump_applied"] for d in tenant_details if d["bump_applied"]]
            bump_desc = "; ".join(bump_descs) if bump_descs else ""

        schedule.append({
            "year": yr,
            "scheduled_rent": round(total_rent, 2),
            "rent_per_sf": round(blended_rent_psf, 2),
            "bump_applied": bump_desc,
            "vacancy_loss": round(total_vacancy, 2),
            "effective_gross_income": round(total_egi, 2),
            "leasing_costs": round(total_leasing, 2),
            "lease_status": agg_status,
            "tenant_details": tenant_details,
        })

    return schedule


# ---------------------------------------------------------------------------
# Phase 2: Debt Modeling + DSCR
# ---------------------------------------------------------------------------

def build_debt_schedule(
    purchase_price: float,
    noi_year1: float,
    debt_assumptions: dict,
    hold_period_years: int,
) -> dict:
    """Build a year-by-year debt schedule.

    Loan sizing: min(LTV-based, DSCR-constrained).
    Annual debt service: IO during IO period, P&I during amortization.

    Returns dict with loan_amount_ltv, loan_amount_dscr, loan_amount_final,
    equity_required, ltv_actual, debt_yield, schedule.
    """
    ltv_pct = _safe_float(debt_assumptions.get("ltv_pct"), 0.65)
    rate = _safe_float(debt_assumptions.get("interest_rate"), 0.055)
    amort_years = int(_safe_float(debt_assumptions.get("amort_years"), 30))
    io_years = int(_safe_float(debt_assumptions.get("io_years"), 0))
    dscr_constraint = _safe_float(debt_assumptions.get("dscr_constraint"), 1.25)

    # Loan sizing
    loan_ltv = purchase_price * ltv_pct

    # DSCR-constrained loan: max loan where NOI / annual_DS >= dscr_constraint
    # For IO: DS = loan * rate, so loan_dscr = NOI / (rate * dscr_constraint)
    # For amortizing: DS = loan * (r*(1+r)^n) / ((1+r)^n - 1), so loan_dscr = NOI / (payment_constant * dscr_constraint)
    if io_years > 0:
        # Size based on IO debt service
        if rate > 0:
            loan_dscr = noi_year1 / (rate * dscr_constraint)
        else:
            loan_dscr = loan_ltv  # no interest = no constraint
    else:
        # Size based on amortizing debt service
        monthly_rate = rate / 12.0
        n_periods = amort_years * 12
        if monthly_rate > 0 and n_periods > 0:
            payment_constant_monthly = (monthly_rate * (1 + monthly_rate) ** n_periods) / ((1 + monthly_rate) ** n_periods - 1)
            annual_payment_per_dollar = payment_constant_monthly * 12
            loan_dscr = noi_year1 / (annual_payment_per_dollar * dscr_constraint)
        else:
            loan_dscr = loan_ltv

    loan_amount = min(loan_ltv, loan_dscr)
    loan_amount = max(0.0, loan_amount)
    equity_required = purchase_price - loan_amount
    ltv_actual = _safe_div(loan_amount, purchase_price, 0.0)
    debt_yield = _safe_div(noi_year1, loan_amount, 0.0)

    # Build year-by-year schedule
    schedule: list[dict] = []
    balance = loan_amount
    monthly_rate = rate / 12.0
    n_amort_periods = amort_years * 12

    for yr in range(1, hold_period_years + 1):
        beginning_balance = balance
        is_io = yr <= io_years

        if is_io:
            # Interest-only
            interest = balance * rate
            principal = 0.0
            total_ds = interest
        else:
            # P&I (standard amortization formula)
            if monthly_rate > 0 and balance > 0:
                # Remaining amort periods from start of amortization
                amort_year = yr - io_years
                remaining_amort_months = n_amort_periods - (amort_year - 1) * 12
                if remaining_amort_months <= 0:
                    interest = 0.0
                    principal = 0.0
                    total_ds = 0.0
                else:
                    monthly_payment = balance * (monthly_rate * (1 + monthly_rate) ** remaining_amort_months) / ((1 + monthly_rate) ** remaining_amort_months - 1)
                    # Compute annual interest and principal
                    annual_interest = 0.0
                    annual_principal = 0.0
                    temp_balance = balance
                    for _ in range(12):
                        if temp_balance <= 0:
                            break
                        month_interest = temp_balance * monthly_rate
                        month_principal = min(monthly_payment - month_interest, temp_balance)
                        annual_interest += month_interest
                        annual_principal += month_principal
                        temp_balance -= month_principal
                    interest = annual_interest
                    principal = annual_principal
                    total_ds = interest + principal
                    balance = temp_balance
            else:
                # Zero rate — principal only
                if n_amort_periods > 0:
                    annual_principal = loan_amount / amort_years
                    principal = min(annual_principal, balance)
                    interest = 0.0
                    total_ds = principal
                    balance -= principal
                else:
                    interest = 0.0
                    principal = 0.0
                    total_ds = 0.0

        if is_io:
            ending_balance = balance
        else:
            ending_balance = balance

        schedule.append({
            "year": yr,
            "beginning_balance": round(beginning_balance, 2),
            "interest": round(interest, 2),
            "principal": round(principal, 2),
            "total_debt_service": round(total_ds, 2),
            "ending_balance": round(max(ending_balance, 0), 2),
            "is_io_period": is_io,
        })

    return {
        "loan_amount_ltv": round(loan_ltv, 2),
        "loan_amount_dscr": round(loan_dscr, 2),
        "loan_amount_final": round(loan_amount, 2),
        "equity_required": round(equity_required, 2),
        "ltv_actual": round(ltv_actual, 5),
        "debt_yield": round(debt_yield, 5),
        "schedule": schedule,
    }


def compute_leveraged_returns(
    cash_flow: list[dict],
    debt_schedule: list[dict],
    equity: float,
    net_proceeds: float,
) -> dict:
    """Compute leveraged IRR and equity multiple.

    Builds leveraged CF: [-equity, (noi_1 - ds_1), ..., (noi_n - ds_n + net_proceeds - loan_payoff)]
    """
    if equity <= 0 or not cash_flow or not debt_schedule:
        return {
            "leveraged_irr": None,
            "leveraged_equity_multiple": 0.0,
            "loan_payoff_at_exit": 0.0,
        }

    hold = len(cash_flow)
    loan_payoff = debt_schedule[-1]["ending_balance"] if debt_schedule else 0.0

    cf_vector: list[float] = [-equity]
    total_cash = 0.0
    for i in range(hold):
        noi = cash_flow[i]["noi"]
        ds = debt_schedule[i]["total_debt_service"] if i < len(debt_schedule) else 0.0
        cash_after_ds = noi - ds
        if i == hold - 1:
            cash_after_ds += net_proceeds - loan_payoff
        cf_vector.append(cash_after_ds)
        total_cash += cash_after_ds

    # Add back the net_proceeds - loan_payoff for total returned
    total_returned = total_cash + equity  # total_cash already includes terminal
    leveraged_em = _safe_div(total_cash + equity, equity, 0.0)

    leveraged_irr = _newton_irr(cf_vector)

    return {
        "leveraged_irr": round(leveraged_irr, 6) if leveraged_irr is not None else None,
        "leveraged_equity_multiple": round(leveraged_em, 4),
        "loan_payoff_at_exit": round(loan_payoff, 2),
    }


# ---------------------------------------------------------------------------
# Phase 4: Absorption / Lease-Up
# ---------------------------------------------------------------------------

def build_absorption_schedule(
    vacant_suites: list[dict],
    hold_period_years: int,
    assumptions: dict,
) -> list[dict]:
    """Build an absorption schedule for vacant suites being leased up.

    Each suite has: suite_id, gla_sf, absorption_month, lease_up_months,
    market_rent_psf, lease_term_years, ti_psf, lc_pct.

    Returns per-year: newly_absorbed_sf, cumulative_absorbed_sf,
    absorption_rent, absorption_ti, absorption_lc.
    """
    schedule: list[dict] = []
    cumulative_sf = 0.0

    for yr in range(1, hold_period_years + 1):
        yr_start_month = (yr - 1) * 12 + 1
        yr_end_month = yr * 12

        newly_absorbed = 0.0
        absorption_rent = 0.0
        absorption_ti = 0.0
        absorption_lc = 0.0

        for suite in vacant_suites:
            suite_gla = _safe_float(suite.get("gla_sf"), 0.0)
            abs_month = int(_safe_float(suite.get("absorption_month"), 1))
            lease_up_months = int(_safe_float(suite.get("lease_up_months"), 0))
            mkt_rent_psf = _safe_float(suite.get("market_rent_psf"), 0.0)
            lease_term = _safe_float(suite.get("lease_term_years"), 5)
            suite_ti_psf = _safe_float(suite.get("ti_psf"), 0.0)
            suite_lc_pct = _safe_float(suite.get("lc_pct"), 0.04)

            # Rent commencement month = absorption_month + lease_up_months
            rent_start_month = abs_month + lease_up_months

            # Check if this suite gets absorbed in this year
            if yr_start_month <= abs_month <= yr_end_month:
                newly_absorbed += suite_gla

                # TI and LC costs in the absorption year
                absorption_ti += suite_ti_psf * suite_gla
                annual_rent = mkt_rent_psf * suite_gla
                total_lease_value = annual_rent * lease_term
                absorption_lc += suite_lc_pct * total_lease_value

            # Prorated rent: how many months of rent in this year?
            if rent_start_month <= yr_end_month:
                # Months of rent in this year
                rent_months_start = max(rent_start_month, yr_start_month)
                rent_months_end = yr_end_month
                months_of_rent = max(0, rent_months_end - rent_months_start + 1)
                monthly_rent = (mkt_rent_psf * suite_gla) / 12.0
                absorption_rent += monthly_rent * months_of_rent

        cumulative_sf += newly_absorbed

        schedule.append({
            "year": yr,
            "newly_absorbed_sf": round(newly_absorbed, 2),
            "cumulative_absorbed_sf": round(cumulative_sf, 2),
            "absorption_rent": round(absorption_rent, 2),
            "absorption_ti": round(absorption_ti, 2),
            "absorption_lc": round(absorption_lc, 2),
        })

    return schedule


def _merge_absorption(rent_schedule: list[dict], absorption_schedule: list[dict]) -> list[dict]:
    """Overlay absorption schedule onto main rent schedule.

    Adds absorption_rent to scheduled_rent and EGI.
    """
    merged = []
    for rs_row in rent_schedule:
        row = dict(rs_row)
        yr = row["year"]
        # Find matching absorption year
        abs_row = None
        for a in absorption_schedule:
            if a["year"] == yr:
                abs_row = a
                break

        if abs_row:
            row["scheduled_rent"] = round(row["scheduled_rent"] + abs_row["absorption_rent"], 2)
            row["effective_gross_income"] = round(row["effective_gross_income"] + abs_row["absorption_rent"], 2)
            row["leasing_costs"] = round(row.get("leasing_costs", 0) + abs_row["absorption_ti"] + abs_row["absorption_lc"], 2)
            row["absorption_rent"] = abs_row["absorption_rent"]
            row["absorption_ti"] = abs_row["absorption_ti"]
            row["absorption_lc"] = abs_row["absorption_lc"]
        merged.append(row)

    return merged


# ---------------------------------------------------------------------------
# Cash flow projection
# ---------------------------------------------------------------------------

def build_cash_flow(rent_schedule: list[dict], assumptions: dict) -> list[dict]:
    """Build year-by-year cash flow from rent schedule and operating assumptions.

    For NNN leases management fee and capex default to zero unless explicitly
    overridden.

    Includes Phase 3 expense reimbursements, Phase 5 scheduled capex,
    and Phase 2 debt service overlay when applicable.

    Args:
        rent_schedule: Output of ``build_rent_schedule``.
        assumptions: Dict with vacancy_rate, mgmt_fee_pct, capex_per_sf, gla_sf,
            and optionally is_nnn / is_absolute_nnn, expense_reimbursements,
            scheduled_capex, debt schedule.

    Returns:
        List of dicts per year with operating metrics and optionally debt metrics.
    """
    is_nnn = assumptions.get("is_nnn", True)
    is_absolute = assumptions.get("is_absolute_nnn", False)
    is_nn = assumptions.get("lease_type", "").upper() in ("NN", "DOUBLE NET")
    vacancy_rate = _safe_float(assumptions.get("vacancy_rate_during_term"), 0.0)
    mgmt_fee_pct = _safe_float(assumptions.get("mgmt_fee_pct"), 0.0)
    capex_per_sf = _safe_float(assumptions.get("capex_per_sf"), 0.0)
    gla_sf = _safe_float(assumptions.get("gla_sf"), 0.0)

    # Phase 3: Expense reimbursements
    reimb = assumptions.get("expense_reimbursements", {})
    cam_psf = _safe_float(reimb.get("cam_psf"), 0.0)
    tax_psf = _safe_float(reimb.get("tax_psf"), 0.0)
    insurance_psf = _safe_float(reimb.get("insurance_psf"), 0.0)
    cam_growth = _safe_float(reimb.get("cam_growth_pct"), 0.03)
    tax_growth = _safe_float(reimb.get("tax_growth_pct"), 0.03)
    insurance_growth = _safe_float(reimb.get("insurance_growth_pct"), 0.02)
    admin_fee_pct = _safe_float(reimb.get("admin_fee_pct"), 0.0)

    # Determine reimbursement recovery rate by lease type
    if is_nnn or is_absolute:
        recovery_rate = 1.0  # 100% recovery
    elif is_nn:
        recovery_rate = 0.67  # ~67%
    else:
        recovery_rate = 0.0  # Gross lease = no recovery

    # Phase 5: Scheduled capex
    scheduled_capex_items = assumptions.get("scheduled_capex") or []

    # Phase 2: Debt schedule
    debt_data = assumptions.get("_debt_schedule_data")
    debt_schedule = debt_data.get("schedule", []) if debt_data else []
    dscr_covenant = _safe_float(
        assumptions.get("debt", {}).get("dscr_covenant", 1.20)
        if isinstance(assumptions.get("debt"), dict) else 1.20
    )

    # NNN defaults: landlord bears almost nothing
    if is_nnn and mgmt_fee_pct == 0.0 and "mgmt_fee_pct" not in assumptions:
        mgmt_fee_pct = 0.0
    if is_absolute and capex_per_sf == 0.0 and "capex_per_sf" not in assumptions:
        capex_per_sf = 0.0

    cash_flow: list[dict] = []
    cumulative_noi = 0.0

    for entry in rent_schedule:
        yr = entry["year"]
        egi = entry["effective_gross_income"]
        leasing_costs = entry.get("leasing_costs", 0.0)
        lease_status = entry.get("lease_status", "in_place")

        # Additional vacancy adjustment (beyond what rent schedule already deducted)
        additional_vacancy = egi * vacancy_rate
        egi_after_vacancy = egi - additional_vacancy

        # Phase 3: Expense reimbursements
        cam_reimb_yr = cam_psf * (1 + cam_growth) ** (yr - 1) * gla_sf * recovery_rate
        tax_reimb_yr = tax_psf * (1 + tax_growth) ** (yr - 1) * gla_sf * recovery_rate
        ins_reimb_yr = insurance_psf * (1 + insurance_growth) ** (yr - 1) * gla_sf * recovery_rate
        total_reimbursements = cam_reimb_yr + tax_reimb_yr + ins_reimb_yr
        reimb_admin_fee = total_reimbursements * admin_fee_pct
        # Gross-up vacancy cost: vacancy rate applied to reimbursements
        gross_up_vacancy_cost = total_reimbursements * vacancy_rate

        # Add reimbursements to revenue, subtract admin fee and vacancy gross-up
        egi_with_reimb = egi_after_vacancy + total_reimbursements - reimb_admin_fee - gross_up_vacancy_cost

        mgmt_fee = egi_with_reimb * mgmt_fee_pct
        capex_reserve = capex_per_sf * gla_sf

        # Phase 5: Scheduled capex for this year
        scheduled_items = [c for c in scheduled_capex_items if c.get("year") == yr]
        scheduled_capex = sum(_safe_float(c.get("cost"), 0.0) for c in scheduled_items)
        total_capex = capex_reserve + scheduled_capex

        landlord_opex = 0.0  # placeholder for future landlord responsibility costs

        total_opex = mgmt_fee + total_capex + landlord_opex + leasing_costs
        noi = egi_with_reimb - total_opex
        cumulative_noi += noi

        row: dict[str, Any] = {
            "year": yr,
            "effective_gross_income": round(egi_with_reimb, 2),
            "mgmt_fee": round(mgmt_fee, 2),
            "capex_reserve": round(capex_reserve, 2),
            "scheduled_capex": round(scheduled_capex, 2),
            "total_capex": round(total_capex, 2),
            "leasing_costs": round(leasing_costs, 2),
            "landlord_opex": round(landlord_opex, 2),
            "total_operating_expenses": round(total_opex, 2),
            "noi": round(noi, 2),
            "cumulative_noi": round(cumulative_noi, 2),
            "lease_status": lease_status,
            # Phase 3: Reimbursement details
            "cam_reimbursement": round(cam_reimb_yr, 2),
            "tax_reimbursement": round(tax_reimb_yr, 2),
            "insurance_reimbursement": round(ins_reimb_yr, 2),
            "total_reimbursements": round(total_reimbursements, 2),
            "reimbursement_admin_fee": round(reimb_admin_fee, 2),
            "gross_up_vacancy_cost": round(gross_up_vacancy_cost, 2),
        }

        # Phase 2: Overlay debt service if available
        if debt_schedule:
            ds_row = debt_schedule[yr - 1] if yr - 1 < len(debt_schedule) else None
            if ds_row:
                ds = ds_row["total_debt_service"]
                row["debt_service"] = round(ds, 2)
                row["cash_after_debt_service"] = round(noi - ds, 2)
                dscr = _safe_div(noi, ds, 0.0)
                row["dscr"] = round(dscr, 4)
                row["dscr_below_covenant"] = dscr < dscr_covenant if ds > 0 else False

        cash_flow.append(row)

    return cash_flow


# ---------------------------------------------------------------------------
# Exit analysis & IRR
# ---------------------------------------------------------------------------

def _newton_irr(
    cash_flows: list[float],
    guess: float = 0.08,
    tol: float = 1e-9,
    max_iter: int = 200,
) -> Optional[float]:
    """Compute IRR using Newton-Raphson method.

    Args:
        cash_flows: List of cash flows where index 0 is time-0 (typically negative).
        guess: Starting estimate for IRR.
        tol: Convergence tolerance.
        max_iter: Maximum iterations.

    Returns:
        IRR as a decimal, or None if it does not converge.
    """
    rate = guess
    for _ in range(max_iter):
        npv = 0.0
        dnpv = 0.0
        for t, cf in enumerate(cash_flows):
            denom = (1 + rate) ** t
            if abs(denom) < 1e-15:
                return None
            npv += cf / denom
            if t > 0:
                dnpv -= t * cf / ((1 + rate) ** (t + 1))
        if abs(dnpv) < 1e-15:
            # Derivative too small — try bisection fallback
            return _bisection_irr(cash_flows)
        new_rate = rate - npv / dnpv
        if abs(new_rate - rate) < tol:
            return new_rate
        rate = new_rate
        # Guard against divergence
        if abs(rate) > 10:
            return _bisection_irr(cash_flows)
    return _bisection_irr(cash_flows)


def _bisection_irr(
    cash_flows: list[float],
    lo: float = -0.5,
    hi: float = 5.0,
    tol: float = 1e-9,
    max_iter: int = 300,
) -> Optional[float]:
    """Fallback IRR solver using bisection."""

    def _npv(rate: float) -> float:
        return sum(cf / (1 + rate) ** t for t, cf in enumerate(cash_flows))

    npv_lo = _npv(lo)
    npv_hi = _npv(hi)
    if npv_lo * npv_hi > 0:
        return None  # no sign change — no real IRR in range

    for _ in range(max_iter):
        mid = (lo + hi) / 2
        npv_mid = _npv(mid)
        if abs(npv_mid) < tol or (hi - lo) / 2 < tol:
            return mid
        if npv_mid * npv_lo < 0:
            hi = mid
        else:
            lo = mid
            npv_lo = npv_mid
    return (lo + hi) / 2


def compute_exit_analysis(
    cash_flow: list[dict],
    assumptions: dict,
    purchase_price: float,
) -> dict:
    """Compute exit-year sale proceeds, equity multiple, and unleveraged IRR.

    Uses the NOI of the year *after* the hold period (forward-year NOI) for
    exit pricing.  If unavailable, falls back to the final-year NOI.

    When debt data is available, also computes leveraged returns.

    Args:
        cash_flow: Output of ``build_cash_flow``.
        assumptions: Must contain exit_cap_rate_final, cost_of_sale_pct.
        purchase_price: Total acquisition cost.

    Returns:
        Dict with gross_sale_price, cost_of_sale, net_proceeds,
        equity_multiple, unleveraged_irr, and optionally leveraged metrics.
    """
    exit_cap = _safe_float(assumptions.get("exit_cap_rate_final"), 0.07)
    cost_of_sale_pct = _safe_float(assumptions.get("cost_of_sale_pct"), 0.015)
    hold = len(cash_flow)

    if hold == 0 or purchase_price <= 0:
        return {
            "gross_sale_price": 0,
            "cost_of_sale": 0,
            "net_proceeds": 0,
            "equity_multiple": 0,
            "unleveraged_irr": None,
        }

    # Forward-year NOI: grow last year NOI by same growth rate as last two years
    last_noi = cash_flow[-1]["noi"]
    if hold >= 2:
        prev_noi = cash_flow[-2]["noi"]
        growth = _safe_div(last_noi - prev_noi, prev_noi, 0.0)
        noi_exit_forward = last_noi * (1 + growth)
    else:
        noi_exit_forward = last_noi

    gross_sale = _safe_div(noi_exit_forward, exit_cap, 0.0)
    cost_of_sale = gross_sale * cost_of_sale_pct
    net_proceeds = gross_sale - cost_of_sale

    # Build cash-flow vector for IRR: [-purchase, noi_1, noi_2, ..., noi_n + net_proceeds]
    cf_vector: list[float] = [-purchase_price]
    for i, row in enumerate(cash_flow):
        cf = row["noi"]
        if i == hold - 1:
            cf += net_proceeds
        cf_vector.append(cf)

    total_noi = sum(row["noi"] for row in cash_flow)
    equity_multiple = _safe_div(total_noi + net_proceeds, purchase_price, 0.0)

    irr = _newton_irr(cf_vector)

    result = {
        "gross_sale_price": round(gross_sale, 2),
        "cost_of_sale": round(cost_of_sale, 2),
        "net_proceeds": round(net_proceeds, 2),
        "equity_multiple": round(equity_multiple, 4),
        "unleveraged_irr": round(irr, 6) if irr is not None else None,
    }

    # Phase 2: Leveraged returns when debt data available
    debt_data = assumptions.get("_debt_schedule_data")
    if debt_data and debt_data.get("schedule"):
        leveraged = compute_leveraged_returns(
            cash_flow,
            debt_data["schedule"],
            debt_data["equity_required"],
            net_proceeds,
        )
        result["leveraged_irr"] = leveraged["leveraged_irr"]
        result["leveraged_equity_multiple"] = leveraged["leveraged_equity_multiple"]
        result["loan_payoff_at_exit"] = leveraged["loan_payoff_at_exit"]

    return result


# ---------------------------------------------------------------------------
# Sensitivity grid
# ---------------------------------------------------------------------------

def build_sensitivity_grid(
    cash_flow: list[dict],
    assumptions: dict,
    purchase_price: float,
) -> dict:
    """Generate a matrix of IRR and equity-multiple across hold periods and exit cap rates.

    Hold periods: [3, 5, 7, 10].
    Exit cap rates: entry cap rate from -50 bps to +150 bps in 25 bps steps.

    When debt data is available, also computes leveraged IRR and EM matrices.

    Args:
        cash_flow: Full-length cash flow (must cover at least max hold period).
        assumptions: Must include asking_cap_rate.
        purchase_price: Acquisition cost.

    Returns:
        Dict with hold_periods, exit_cap_rates, irr_matrix, em_matrix,
        and optionally leveraged_irr_matrix, leveraged_em_matrix.
    """
    entry_cap = _safe_float(assumptions.get("asking_cap_rate"), 0.065)
    hold_periods = [3, 5, 7, 10]
    exit_cap_rates = [
        round(entry_cap + bps / 10_000, 5)
        for bps in range(-50, 151, 25)
    ]

    irr_matrix: list[list[Optional[float]]] = []
    em_matrix: list[list[Optional[float]]] = []
    leveraged_irr_matrix: list[list[Optional[float]]] = []
    leveraged_em_matrix: list[list[Optional[float]]] = []

    debt_data = assumptions.get("_debt_schedule_data")
    has_debt = debt_data is not None and bool(debt_data.get("schedule"))

    for hold in hold_periods:
        irr_row: list[Optional[float]] = []
        em_row: list[Optional[float]] = []
        lev_irr_row: list[Optional[float]] = []
        lev_em_row: list[Optional[float]] = []

        # Slice cash flow to hold period length
        cf_slice = cash_flow[:hold]
        if len(cf_slice) < hold:
            while len(cf_slice) < hold:
                last = cf_slice[-1].copy() if cf_slice else {"year": len(cf_slice) + 1, "noi": 0}
                last["year"] = len(cf_slice) + 1
                cf_slice.append(last)

        for ecap in exit_cap_rates:
            a_copy = dict(assumptions)
            a_copy["exit_cap_rate_final"] = ecap
            result = compute_exit_analysis(cf_slice, a_copy, purchase_price)
            irr_row.append(result["unleveraged_irr"])
            em_row.append(result["equity_multiple"])

            if has_debt:
                lev_irr_row.append(result.get("leveraged_irr"))
                lev_em_row.append(result.get("leveraged_equity_multiple"))

        irr_matrix.append(irr_row)
        em_matrix.append(em_row)
        if has_debt:
            leveraged_irr_matrix.append(lev_irr_row)
            leveraged_em_matrix.append(lev_em_row)

    output = {
        "hold_periods": hold_periods,
        "exit_cap_rates": [round(c, 5) for c in exit_cap_rates],
        "irr_matrix": irr_matrix,
        "em_matrix": em_matrix,
    }

    if has_debt:
        output["leveraged_irr_matrix"] = leveraged_irr_matrix
        output["leveraged_em_matrix"] = leveraged_em_matrix

    return output


# ---------------------------------------------------------------------------
# Pricing analysis
# ---------------------------------------------------------------------------

def compute_pricing(
    noi_year1: float,
    target_cap_rate: float,
    max_cap_rate: float,
) -> dict:
    """Compute target, walk-away, and upside prices with cap-rate sensitivity.

    Args:
        noi_year1: Year-1 NOI.
        target_cap_rate: Investor's target acquisition cap rate.
        max_cap_rate: Walk-away (ceiling) cap rate.

    Returns:
        Dict with target_price, walk_away_price, upside_price,
        cap_rate_sensitivity.
    """
    target_price = _safe_div(noi_year1, target_cap_rate, 0.0)
    walk_away_price = _safe_div(noi_year1, max_cap_rate, 0.0)
    # Upside: 50 bps tighter than target
    upside_cap = max(target_cap_rate - 0.005, 0.001)
    upside_price = _safe_div(noi_year1, upside_cap, 0.0)

    # Sensitivity: target -50 bps to +50 bps in 10 bps steps
    sensitivity: list[dict] = []
    for delta_bps in range(-50, 51, 10):
        cap = target_cap_rate + delta_bps / 10_000
        if cap <= 0:
            continue
        sensitivity.append({
            "cap_rate": round(cap, 5),
            "price": round(_safe_div(noi_year1, cap, 0.0), 2),
        })

    return {
        "target_price": round(target_price, 2),
        "walk_away_price": round(walk_away_price, 2),
        "upside_price": round(upside_price, 2),
        "cap_rate_sensitivity": sensitivity,
    }


# ---------------------------------------------------------------------------
# Risk scoring
# ---------------------------------------------------------------------------

_MARKET_RENT_RANGES: dict[str, tuple[float, float]] = {
    # Rough national benchmarks per SF for single-tenant NNN (annual)
    "default": (15.0, 45.0),
}


def score_risk(deal_schema: dict, assumptions: dict | None = None) -> dict:
    """Score deal risk across weighted risk dimensions.

    Returns a composite risk score (0-100), tier label, and list of triggered
    risk flags with severity and detail.

    Risk Flags 1-12: Original flags.
    Flag 13: Short WALT (WALT < 4yr) — High, weight 0.15
    Flag 14: Tenant Concentration (any tenant > 60% of total rent) — Moderate, weight 0.10
    Flag 15: DSCR Below Covenant — High, weight 0.15
    """
    lease = deal_schema.get("lease", {})
    tenant = deal_schema.get("tenant", {})
    financials = deal_schema.get("financials_as_stated", {})
    prop = deal_schema.get("property", {})

    remaining = _safe_float(lease.get("remaining_term_years"))
    options = lease.get("options") or []
    lease_type = (lease.get("type") or "").upper()
    rent_bumps = lease.get("rent_bumps") or []
    rent_psf = _safe_float(lease.get("rent_per_sf"))
    asking_cap = _safe_float(financials.get("asking_cap_rate"))
    is_corporate = bool(tenant.get("is_corporate_guarantee", True))
    moodys = (tenant.get("credit_rating_moodys") or "").strip()
    sp = (tenant.get("credit_rating_sp") or "").strip()
    market_type = (prop.get("market_type") or "").lower()
    property_subtype = (prop.get("property_subtype") or "").lower()
    has_drive_thru = bool(prop.get("has_drive_thru", True))
    tenant_name = (tenant.get("name") or "").lower()

    # Phase 1: WALT and tenant concentration
    a = assumptions or {}
    walt = _safe_float(a.get("walt"), remaining)
    tenant_count = int(_safe_float(a.get("tenant_count"), 1))

    # Tenant concentration check
    tenants = _normalize_tenants(deal_schema)
    has_concentration_risk = False
    if len(tenants) > 1:
        total_rent = sum(_safe_float(t.get("lease", {}).get("base_rent_annual")) for t in tenants)
        if total_rent > 0:
            for t in tenants:
                t_rent = _safe_float(t.get("lease", {}).get("base_rent_annual"))
                if _safe_div(t_rent, total_rent, 0.0) > 0.60:
                    has_concentration_risk = True
                    break

    # Phase 2: DSCR below covenant check
    dscr_below_covenant = False
    debt_data = a.get("_debt_schedule_data")
    if debt_data and a.get("_cash_flow_data"):
        cf_data = a.get("_cash_flow_data", [])
        for row in cf_data:
            if row.get("dscr_below_covenant", False):
                dscr_below_covenant = True
                break

    # Define severity scores: High=100, Moderate=60, Low=30
    severity_scores = {"high": 100, "moderate": 60, "low": 30}

    # All flags with their weights (will be normalised)
    flag_defs = [
        {
            "id": 1,
            "flag": "Short Lease Term",
            "trigger": remaining < 5,
            "severity": "high",
            "weight": 0.20,
            "detail": f"Remaining term is {remaining:.1f} years (< 5 yr threshold)",
        },
        {
            "id": 2,
            "flag": "No Renewal Options",
            "trigger": len(options) == 0,
            "severity": "high",
            "weight": 0.10,
            "detail": "Lease has no renewal options",
        },
        {
            "id": 3,
            "flag": "Franchisee Guarantee Only",
            "trigger": not is_corporate,
            "severity": "moderate",
            "weight": 0.10,
            "detail": "Lease guaranteed by franchisee only, not corporate parent",
        },
        {
            "id": 4,
            "flag": "Modified NNN Structure",
            "trigger": "MODIFIED" in lease_type or lease_type in ("NN", "GROSS", "MODIFIED-GROSS", "MODIFIED GROSS"),
            "severity": "moderate",
            "weight": 0.15,
            "detail": f"Lease type is {lease_type}; landlord may bear some operating costs",
        },
        {
            "id": 5,
            "flag": "Flat Rent Bumps",
            "trigger": _has_flat_bumps_only(rent_bumps),
            "severity": "low",
            "weight": 0.10,
            "detail": "Rent increases are flat-dollar only (no inflation protection)",
        },
        {
            "id": 6,
            "flag": "Below-Market Rent",
            "trigger": _is_below_market(rent_psf, prop),
            "severity": "high",
            "weight": 0.10,
            "detail": f"Rent ${rent_psf:.2f}/SF may be below market range",
        },
        {
            "id": 7,
            "flag": "Above-Market Rent",
            "trigger": _is_above_market(rent_psf, prop),
            "severity": "moderate",
            "weight": 0.10,
            "detail": f"Rent ${rent_psf:.2f}/SF may be above market (reversion risk)",
        },
        {
            "id": 8,
            "flag": "Tertiary Market",
            "trigger": "tertiary" in market_type or "rural" in market_type,
            "severity": "moderate",
            "weight": 0.15,
            "detail": f"Property located in a tertiary/rural market",
        },
        {
            "id": 9,
            "flag": "Unrated Tenant",
            "trigger": (not moodys or moodys.lower() in ("nr", "n/a", "unrated", ""))
                       and (not sp or sp.lower() in ("nr", "n/a", "unrated", "")),
            "severity": "moderate",
            "weight": 0.20,
            "detail": "Tenant has no public credit rating from Moody's or S&P",
        },
        {
            "id": 10,
            "flag": "High Asking Cap Rate",
            "trigger": asking_cap > 0.08,
            "severity": "low",
            "weight": 0.05,
            "detail": f"Asking cap rate {asking_cap:.2%} exceeds 8% (may signal risk)",
        },
        {
            "id": 11,
            "flag": "Low Asking Cap Rate",
            "trigger": 0 < asking_cap < 0.045,
            "severity": "high",
            "weight": 0.05,
            "detail": f"Asking cap rate {asking_cap:.2%} below 4.5% (compressed returns)",
        },
        {
            "id": 12,
            "flag": "Drive-Thru Required",
            "trigger": _is_qsr_without_drive_thru(tenant_name, property_subtype, has_drive_thru),
            "severity": "high",
            "weight": 0.10,
            "detail": "QSR tenant without drive-thru; critical for re-tenanting",
        },
        # Phase 1: New flags
        {
            "id": 13,
            "flag": "Short WALT",
            "trigger": walt < 4.0,
            "severity": "high",
            "weight": 0.15,
            "detail": f"Weighted average lease term is {walt:.1f} years (< 4 yr threshold)",
        },
        {
            "id": 14,
            "flag": "Tenant Concentration",
            "trigger": has_concentration_risk,
            "severity": "moderate",
            "weight": 0.10,
            "detail": "A single tenant accounts for more than 60% of total rent",
        },
        # Phase 2: DSCR flag
        {
            "id": 15,
            "flag": "DSCR Below Covenant",
            "trigger": dscr_below_covenant,
            "severity": "high",
            "weight": 0.15,
            "detail": "Projected DSCR falls below covenant threshold in one or more years",
        },
    ]

    # Normalise weights
    total_weight = sum(f["weight"] for f in flag_defs)
    for f in flag_defs:
        f["norm_weight"] = f["weight"] / total_weight if total_weight > 0 else 0

    risk_flags: list[dict] = []
    weighted_score = 0.0

    for f in flag_defs:
        if f["trigger"]:
            risk_flags.append({
                "flag": f["flag"],
                "trigger_condition": True,
                "severity": f["severity"],
                "detail": f["detail"],
            })
            weighted_score += severity_scores[f["severity"]] * f["norm_weight"]

    risk_score = min(100, max(0, round(weighted_score)))

    if risk_score <= 25:
        tier = "Low"
    elif risk_score <= 40:
        tier = "Moderate"
    elif risk_score <= 65:
        tier = "Elevated"
    else:
        tier = "High"

    return {
        "risk_score": risk_score,
        "risk_tier": tier,
        "risk_flags": risk_flags,
    }


def _has_flat_bumps_only(bumps: list[dict]) -> bool:
    """Return True if all bumps are flat-dollar (no percentage increases)."""
    if not bumps:
        return False  # no bumps != flat bumps
    for b in bumps:
        bt = (b.get("bump_type") or "").lower()
        if "pct" in bt or "percent" in bt or "cpi" in bt or "fix" in bt:
            return False
    return True


def _is_below_market(rent_psf: float, prop: dict) -> bool:
    """Heuristic: rent is below the low end of national NNN range."""
    if rent_psf <= 0:
        return False
    low, _ = _MARKET_RENT_RANGES.get("default", (15.0, 45.0))
    return rent_psf < low * 0.7  # 30% below low end


def _is_above_market(rent_psf: float, prop: dict) -> bool:
    """Heuristic: rent is above the high end of national NNN range."""
    if rent_psf <= 0:
        return False
    _, high = _MARKET_RENT_RANGES.get("default", (15.0, 45.0))
    return rent_psf > high * 1.3  # 30% above high end


_QSR_KEYWORDS = [
    "mcdonald", "burger king", "wendy", "taco bell", "chick-fil-a",
    "popeyes", "sonic", "jack in the box", "arby", "hardee",
    "carl's jr", "whataburger", "in-n-out", "five guys", "raising cane",
    "wingstop", "zaxby", "culver", "shake shack", "chipotle",
    "panda express", "kfc", "pizza hut", "domino", "papa john",
    "dunkin", "starbucks", "tim horton", "dutch bros",
]


def _is_qsr_without_drive_thru(
    tenant_name: str,
    property_subtype: str,
    has_drive_thru: bool,
) -> bool:
    """Return True if tenant is a QSR and property lacks a drive-thru."""
    is_qsr = any(kw in tenant_name for kw in _QSR_KEYWORDS) or "qsr" in property_subtype
    return is_qsr and not has_drive_thru


# ---------------------------------------------------------------------------
# Recommendation
# ---------------------------------------------------------------------------

def recommend(
    risk_score: int,
    risk_flags: list[dict],
    pricing_output: dict,
    assumptions: dict,
) -> dict:
    """Generate a Go / Watch / Pass recommendation.

    Logic:
        - **Go**: score <= 40, no High-severity flags, price within target.
        - **Watch**: score 41-65, or 1-2 Moderate flags.
        - **Pass**: score > 65, any High-severity flag, or price > walk-away.

    Returns:
        Dict with recommendation, rationale, top_factors.
    """
    high_flags = [f for f in risk_flags if f["severity"] == "high"]
    moderate_flags = [f for f in risk_flags if f["severity"] == "moderate"]

    asking_price = _safe_float(assumptions.get("asking_price"))
    walk_away = _safe_float(pricing_output.get("walk_away_price"))
    target_price = _safe_float(pricing_output.get("target_price"))

    price_above_walk_away = asking_price > 0 and walk_away > 0 and asking_price > walk_away

    top_factors: list[str] = []

    # Determine recommendation
    if risk_score > 65 or len(high_flags) >= 1 or price_above_walk_away:
        recommendation = "pass"
        if len(high_flags) >= 1:
            top_factors.extend(f["flag"] for f in high_flags[:3])
        if price_above_walk_away:
            top_factors.append("Asking price exceeds walk-away threshold")
        if risk_score > 65:
            top_factors.append(f"Risk score {risk_score} exceeds threshold")
        rationale = (
            f"Risk score of {risk_score} ({len(high_flags)} high-severity flag(s)) "
            f"indicates unacceptable risk profile."
        )
    elif risk_score <= 40 and len(high_flags) == 0:
        recommendation = "go"
        rationale = (
            f"Risk score of {risk_score} with no high-severity flags. "
            f"Deal metrics are within acceptable parameters."
        )
        if target_price > 0 and asking_price > 0:
            discount = (target_price - asking_price) / target_price
            if discount > 0:
                top_factors.append(f"Priced {discount:.1%} below target")
            else:
                top_factors.append(f"Priced {abs(discount):.1%} above target (negotiate)")
        if len(moderate_flags) > 0:
            top_factors.extend(f["flag"] for f in moderate_flags[:2])
    else:
        recommendation = "watch"
        rationale = (
            f"Risk score of {risk_score} with {len(moderate_flags)} moderate flag(s). "
            f"Further diligence recommended before proceeding."
        )
        top_factors.extend(f["flag"] for f in (high_flags + moderate_flags)[:3])

    if not top_factors:
        top_factors = [f["flag"] for f in risk_flags[:3]] if risk_flags else ["No material risk flags"]

    return {
        "recommendation": recommendation,
        "rationale": rationale,
        "top_factors": top_factors,
    }


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def run_underwriting(deal_schema: dict, assumptions: Optional[dict] = None) -> dict:
    """Run the full underwriting pipeline and return the complete output.

    Phase 6 integration: Full order:
    1. Build & merge assumptions
    2. Derive purchase price, NOI
    3. Rent schedule with market growth
    4. Absorption overlay if enabled
    5. Cash flow with reimbursements + scheduled capex
    6. Debt schedule if enabled
    7. Exit analysis with leveraged returns
    8. Sensitivity grid with leveraged matrices
    9. Pricing
    10. Risk scoring with new flags
    11. Recommendation
    12. Summary with new metrics (WALT, DSCR, leveraged IRR)
    13. Return all outputs including debt_schedule, debt_summary

    Args:
        deal_schema: Canonical deal schema with property, lease, tenant,
            financials_as_stated sections.
        assumptions: Optional overrides; merged on top of defaults built from
            the deal schema.

    Returns:
        Complete underwriting output dict with sections: assumptions,
        rent_schedule, cash_flow, exit_analysis, sensitivity_grid,
        pricing, risk, recommendation, summary, and optionally
        debt_schedule, debt_summary.
    """
    # 1. Build & merge assumptions
    defaults = build_default_assumptions(deal_schema)
    if assumptions:
        # Deep-merge nested dicts (debt, absorption, releasing, etc.)
        for key, val in assumptions.items():
            if isinstance(val, dict) and isinstance(defaults.get(key), dict):
                defaults[key].update(val)
            else:
                defaults[key] = val
    a = defaults

    # 2. Derive purchase price, NOI
    financials = deal_schema.get("financials_as_stated", {})
    asking_price = _safe_float(financials.get("asking_price"))
    asking_cap = _safe_float(financials.get("asking_cap_rate"), _safe_float(a.get("asking_cap_rate"), 0.065))
    noi_year1 = _safe_float(financials.get("noi_year1"))
    prop = deal_schema.get("property", {})
    gla_sf = _safe_float(a.get("gla_sf")) or _safe_float(
        prop.get("gla_sf") or prop.get("building_square_footage"), 1.0
    )

    hold = int(a.get("hold_period_years", 5))
    # Ensure enough years for sensitivity grid (max 10)
    projection_years = max(hold, 10)

    # Carry asking_price into assumptions for recommendation logic
    a["asking_price"] = asking_price
    a["asking_cap_rate"] = asking_cap

    # Derive purchase price
    purchase_price = asking_price if asking_price > 0 else _safe_div(noi_year1, asking_cap, 0.0)

    # If NOI year1 not provided, derive from asking price and cap rate
    if noi_year1 <= 0 and purchase_price > 0 and asking_cap > 0:
        noi_year1 = purchase_price * asking_cap

    # 3. Rent schedule with market growth (full projection length)
    rent_schedule = build_rent_schedule(deal_schema, projection_years, gla_sf, a)

    # 4. Absorption overlay if enabled
    absorption_data = a.get("absorption", {})
    absorption_schedule = None
    if absorption_data.get("enabled") and absorption_data.get("vacant_suites"):
        absorption_schedule = build_absorption_schedule(
            absorption_data["vacant_suites"],
            projection_years,
            a,
        )
        rent_schedule = _merge_absorption(rent_schedule, absorption_schedule)

    # 5. Debt schedule if enabled (need it before cash flow for overlay)
    debt_config = a.get("debt", {})
    debt_result = None
    if debt_config.get("loan_enabled"):
        debt_result = build_debt_schedule(
            purchase_price, noi_year1, debt_config, projection_years
        )
        # Store in assumptions for cash flow and exit analysis to access
        a["_debt_schedule_data"] = debt_result

    # 6. Cash flow with reimbursements + scheduled capex + debt overlay
    cash_flow = build_cash_flow(rent_schedule, a)

    # Store cash flow data for risk scoring DSCR check
    a["_cash_flow_data"] = cash_flow

    # 7. Exit analysis with leveraged returns (for the primary hold period)
    cf_hold = cash_flow[:hold]
    exit_analysis = compute_exit_analysis(cf_hold, a, purchase_price)

    # 8. Sensitivity grid with leveraged matrices (needs full projection)
    sensitivity_grid = build_sensitivity_grid(cash_flow, a, purchase_price)

    # 9. Pricing
    target_cap = asking_cap  # use asking as target baseline
    max_cap = asking_cap + 0.015  # walk-away = +150 bps over asking
    pricing = compute_pricing(noi_year1, target_cap, max_cap)

    # 10. Risk scoring with new flags
    risk = score_risk(deal_schema, a)

    # 11. Recommendation
    rec = recommend(risk["risk_score"], risk["risk_flags"], pricing, a)

    # 12. Summary with new metrics
    entry_cap_actual = _safe_div(noi_year1, purchase_price, 0.0) if purchase_price > 0 else asking_cap
    summary = {
        "purchase_price": round(purchase_price, 2),
        "noi_year1": round(noi_year1, 2),
        "entry_cap_rate": round(entry_cap_actual, 5),
        "exit_cap_rate": round(_safe_float(a.get("exit_cap_rate_final")), 5),
        "hold_period_years": hold,
        "equity_multiple": exit_analysis["equity_multiple"],
        "unleveraged_irr": exit_analysis["unleveraged_irr"],
        "risk_score": risk["risk_score"],
        "risk_tier": risk["risk_tier"],
        "recommendation": rec["recommendation"],
        # Phase 1: WALT
        "walt": a.get("walt", 0.0),
        "tenant_count": a.get("tenant_count", 1),
    }

    # Phase 2: Add DSCR and leveraged metrics to summary
    if debt_result:
        summary["leveraged_irr"] = exit_analysis.get("leveraged_irr")
        summary["leveraged_equity_multiple"] = exit_analysis.get("leveraged_equity_multiple")
        # Min DSCR from cash flow
        dscr_values = [r.get("dscr") for r in cf_hold if r.get("dscr") is not None]
        if dscr_values:
            summary["min_dscr"] = round(min(dscr_values), 4)
            summary["avg_dscr"] = round(sum(dscr_values) / len(dscr_values), 4)

    # Clean up internal keys from assumptions before returning
    output_assumptions = {k: v for k, v in a.items() if not k.startswith("_")}

    # 13. Return all outputs
    result = {
        "assumptions": output_assumptions,
        "rent_schedule": rent_schedule[:hold],  # return only hold-period years
        "cash_flow": cf_hold,
        "exit_analysis": exit_analysis,
        "sensitivity_grid": sensitivity_grid,
        "pricing": pricing,
        "risk": risk,
        "recommendation": rec,
        "summary": summary,
    }

    # Phase 2: Include debt schedule and summary
    if debt_result:
        result["debt_schedule"] = debt_result["schedule"][:hold]
        result["debt_summary"] = {
            "loan_amount_ltv": debt_result["loan_amount_ltv"],
            "loan_amount_dscr": debt_result["loan_amount_dscr"],
            "loan_amount_final": debt_result["loan_amount_final"],
            "equity_required": debt_result["equity_required"],
            "ltv_actual": debt_result["ltv_actual"],
            "debt_yield": debt_result["debt_yield"],
        }

    # Phase 4: Include absorption schedule if generated
    if absorption_schedule:
        result["absorption_schedule"] = absorption_schedule[:hold]

    return result
