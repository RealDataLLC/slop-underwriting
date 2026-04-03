// ─── Supabase Database Types ─────────────────────────────────────────────────
// We use an untyped Supabase client and cast results at the call site.
// This avoids the complex generic constraints that Supabase's type system requires.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export type Database = {};

// ─── Projects ────────────────────────────────────────────────────────────────

export type ProjectStatus = "active" | "under_contract" | "closed" | "dead";

export interface UwProject {
  id: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  name: string;
  description: string | null;
  status: ProjectStatus;
  target_cap_rate: number | null;
  max_cap_rate: number | null;
  target_irr: number | null;
  notes: string | null;
}

export type UwProjectInsert = Omit<UwProject, "id" | "created_at" | "updated_at">;

// ─── Properties ──────────────────────────────────────────────────────────────

export type PropertyType = "QSR" | "Pharmacy" | "Dollar" | "Auto" | "C-Store" | "Bank" | "Medical" | "Other";
export type Recommendation = "go" | "watch" | "pass";

export interface UwProperty {
  id: string;
  project_id: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  name: string;
  property_address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  market: string | null;
  property_type: PropertyType | null;
  costar_property_id: number | null;
  latest_deal_id: string | null;
  latest_recommendation: Recommendation | null;
  latest_risk_score: number | null;
  latest_underwritten_at: string | null;
  notes: string | null;
  is_archived: boolean;
}

export type UwPropertyInsert = Omit<UwProperty, "id" | "created_at" | "updated_at" | "latest_deal_id" | "latest_recommendation" | "latest_risk_score" | "latest_underwritten_at">;

// ─── Deals ───────────────────────────────────────────────────────────────────

export type DealStatus = "uploading" | "extracting" | "review" | "underwriting" | "complete" | "archived";

export interface UwDeal {
  id: string;
  property_id: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  label: string | null;
  status: DealStatus;
  human_review_required: boolean;
  review_cleared_by: string | null;
  review_cleared_at: string | null;
  review_summary: string | null;
  deal_schema: DealSchema | null;
  underwriting_output: UnderwritingOutput | null;
  assumption_overrides: AssumptionOverrides | null;
  memo_pdf_key: string | null;
  proforma_excel_key: string | null;
  recommendation: Recommendation | null;
  recommendation_rationale: string | null;
  risk_score: number | null;
}

export type UwDealInsert = Omit<UwDeal, "id" | "created_at" | "updated_at">;

// ─── Documents ───────────────────────────────────────────────────────────────

export type DocumentType = "om" | "rent_roll" | "financial_statement" | "lease" | "other";
export type ExtractionStatus = "pending" | "running" | "complete" | "failed";

export interface UwDocument {
  id: string;
  deal_id: string;
  created_at: string;
  document_type: DocumentType;
  original_filename: string;
  storage_key: string;
  file_size_bytes: number | null;
  mime_type: string | null;
  extraction_status: ExtractionStatus;
  extracted_at: string | null;
  extraction_confidence: Record<string, number> | null;
  page_classification: PageClassification[] | null;
  raw_extraction: Record<string, unknown> | null;
  extraction_error: string | null;
}

export type UwDocumentInsert = Omit<UwDocument, "id" | "created_at">;

// ─── Versions ────────────────────────────────────────────────────────────────

export type VersionTrigger = "initial" | "assumption_override" | "reextraction";

export interface UwVersion {
  id: string;
  deal_id: string;
  created_at: string;
  created_by: string | null;
  version_number: number;
  trigger: VersionTrigger;
  assumptions: AssumptionOverrides;
  rent_schedule: RentScheduleYear[];
  cash_flow_model: CashFlowYear[];
  exit_analysis: ExitAnalysis;
  sensitivity_grid: SensitivityGrid;
  pricing_output: PricingOutput;
  risk_score: number | null;
  risk_flags: RiskFlag[] | null;
  recommendation: Recommendation | null;
}

export type UwVersionInsert = Omit<UwVersion, "id" | "created_at" | "version_number">;

// ─── Comps ───────────────────────────────────────────────────────────────────

export type CreditTier = "investment_grade" | "national_credit" | "franchisee" | "local";
export type LeaseType = "NNN" | "NN" | "Gross" | "Modified-Gross";
export type CompSource = "internal" | "rca" | "costar" | "manual";

export interface UwComp {
  id: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  source_deal_id: string | null;
  property_type: PropertyType;
  property_address: string | null;
  city: string | null;
  state: string | null;
  market: string | null;
  gla_sf: number | null;
  year_built: number | null;
  has_drive_thru: boolean | null;
  tenant_name: string;
  parent_company: string | null;
  credit_tier: CreditTier;
  is_corporate_guarantee: boolean | null;
  lease_type: LeaseType | null;
  remaining_term_years: number | null;
  options_count: number | null;
  close_date: string;
  sale_price: number;
  noi: number;
  cap_rate: number;
  price_per_sf: number | null;
  source: CompSource;
  source_id: string | null;
  notes: string | null;
}

export type UwCompInsert = Omit<UwComp, "id" | "created_at" | "updated_at" | "cap_rate">;

// ─── Canonical Deal Schema (Section 5C) ──────────────────────────────────────

export interface DealSchema {
  property: {
    address: string | null;
    city: string | null;
    state: string | null;
    market: string | null;
    submarket: string | null;
    year_built: number | null;
    gla_sf: number | null;
    lot_acres: number | null;
    parcel_id: string | null;
    zoning: string | null;
    property_type: PropertyType | null;
  };
  tenant: {
    name: string | null;
    parent_company: string | null;
    concept_type: string | null;
    credit_rating_moodys: string | null;
    credit_rating_sp: string | null;
    is_corporate_guarantee: boolean | null;
    franchisee_operator: string | null;
  };
  lease: {
    type: LeaseType | null;
    is_absolute_nnn: boolean | null;
    commencement_date: string | null;
    expiration_date: string | null;
    remaining_term_years: number | null;
    options: LeaseOption[];
    base_rent_annual: number | null;
    rent_per_sf: number | null;
    rent_bumps: RentBump[];
    landlord_responsibilities: string[];
    tenant_responsibilities: string[];
  };
  financials_as_stated: {
    asking_price: number | null;
    asking_cap_rate: number | null;
    noi_year1: number | null;
    noi_source: "Seller" | "Broker" | "Calculated" | null;
  };
  extraction_metadata: {
    confidence_scores: Record<string, number>;
    flagged_fields: string[];
    extraction_model: string;
    extraction_timestamp: string;
  };
}

export interface LeaseOption {
  term_years: number;
  rent_bump_type: "Flat" | "CPI" | "Fixed-Pct";
  rent_bump_value: number;
}

export interface RentBump {
  effective_date: string;
  bump_type: "Flat" | "CPI" | "Fixed-Pct";
  bump_value: number;
  new_annual_rent: number;
}

export interface PageClassification {
  page_number: number;
  type: "cover" | "financials" | "lease_summary" | "rent_roll" | "photos" | "maps" | "other";
  has_financial_data: boolean;
}

// ─── Underwriting Output Types ───────────────────────────────────────────────

export interface AssumptionOverrides {
  hold_period_years: number;
  exit_cap_rate_mode: "manual" | "spread_to_entry" | "comp_derived";
  exit_cap_rate_manual: number | null;
  exit_cap_rate_spread_bps: number | null;
  exit_cap_rate_comp_derived: number | null;
  exit_cap_rate_final: number;
  cost_of_sale_pct: number;
  reversion_noi_method: "forward_year" | "trailing_12";
  vacancy_rate: number;
  mgmt_fee_pct: number;
  capex_per_sf: number;
  scenarios: {
    bear: { exit_cap_rate: number; hold_period_years: number };
    base: { exit_cap_rate: number; hold_period_years: number };
    bull: { exit_cap_rate: number; hold_period_years: number };
  };
}

export interface RentScheduleYear {
  year: number;
  scheduled_rent: number;
  rent_per_sf: number;
  bump_applied: string | null;
  vacancy_loss: number;
  effective_gross_income: number;
  leasing_costs: number;
  lease_status: "in_place" | "option_period" | "vacant_downtime" | "releasing" | "re_leased";
}

export interface CashFlowYear {
  year: number;
  effective_gross_income: number;
  mgmt_fee: number;
  capex_reserve: number;
  leasing_costs: number;
  landlord_opex: number;
  total_operating_expenses: number;
  noi: number;
  cumulative_noi: number;
  lease_status: string;
}

export interface ExitAnalysis {
  gross_sale_price: number;
  cost_of_sale: number;
  net_proceeds: number;
  equity_multiple: number;
  unleveraged_irr: number;
}

export interface SensitivityGrid {
  hold_periods: number[];
  exit_cap_rates: number[];
  irr_matrix: number[][];
  em_matrix: number[][];
}

export interface PricingOutput {
  target_price: number;
  walk_away_price: number;
  upside_price: number | null;
  cap_rate_sensitivity: { cap_rate: number; price: number }[];
}

export interface UnderwritingOutput {
  rent_schedule: RentScheduleYear[];
  cash_flow_model: CashFlowYear[];
  exit_analysis: ExitAnalysis;
  sensitivity_grid: SensitivityGrid;
  pricing_output: PricingOutput;
  cap_rate_benchmark: {
    market_low: number | null;
    market_mid: number | null;
    market_high: number | null;
    assessment: "tight" | "fair" | "wide" | null;
  } | null;
}

export interface RiskFlag {
  flag: string;
  trigger_condition: string;
  severity: "Low" | "Moderate" | "High";
  detail: string;
}
