"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ChevronRight,
  Loader2,
  AlertCircle,
  SlidersHorizontal,
  Table2,
  DollarSign,
  Grid3X3,
  BarChart3,
  Target,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Minus,
  FileX,
} from "lucide-react";
import { Shell } from "@/components/layout/shell";
import { supabase } from "@/lib/supabase";
import {
  cn,
  formatCurrency,
  formatPercent,
} from "@/lib/utils";
import type {
  UwProject,
  UwProperty,
  UwDeal,
  UwVersion,
  AssumptionOverrides,
  RentScheduleYear,
  CashFlowYear,
  ExitAnalysis,
  SensitivityGrid,
  PricingOutput,
} from "@/lib/types";
import { toast } from "sonner";

// ─── Small currency formatter that includes decimals for per-SF values ────────
function formatCurrencyCompact(value: number | null | undefined): string {
  if (value == null) return "\u2014";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatMultiple(value: number | null | undefined): string {
  if (value == null) return "\u2014";
  return `${value.toFixed(2)}x`;
}

function formatIrr(value: number | null | undefined): string {
  if (value == null) return "\u2014";
  return `${(value * 100).toFixed(2)}%`;
}

// ─── Heat-map color for IRR values relative to a target ──────────────────────
function irrHeatColor(irr: number, targetIrr: number | null): string {
  const target = targetIrr ?? 0.08;
  const diff = irr - target;
  if (diff >= 0.02) return "bg-green-500/80 text-white";
  if (diff >= 0.005) return "bg-green-400/70 text-white";
  if (diff >= -0.005) return "bg-yellow-400/70 text-gray-900";
  if (diff >= -0.02) return "bg-orange-400/70 text-white";
  return "bg-red-500/70 text-white";
}

function emHeatColor(em: number): string {
  if (em >= 1.8) return "bg-green-500/80 text-white";
  if (em >= 1.5) return "bg-green-400/70 text-white";
  if (em >= 1.2) return "bg-yellow-400/70 text-gray-900";
  if (em >= 1.0) return "bg-orange-400/70 text-white";
  return "bg-red-500/70 text-white";
}

// ─── Types ───────────────────────────────────────────────────────────────────

type ExitCapRateMode = "manual" | "spread_to_entry" | "comp_derived";

interface LocalAssumptions {
  hold_period_years: number;
  exit_cap_rate_mode: ExitCapRateMode;
  exit_cap_rate_value: number;
  exit_cap_rate_spread_bps: number;
  cost_of_sale_pct: number;
  vacancy_rate: number;
  mgmt_fee_pct: number;
  capex_per_sf: number;
}

// ─── Main Page Component ─────────────────────────────────────────────────────

export default function ProFormaPage() {
  const params = useParams<{
    projectId: string;
    propertyId: string;
    dealId: string;
  }>();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<UwProject | null>(null);
  const [property, setProperty] = useState<UwProperty | null>(null);
  const [deal, setDeal] = useState<UwDeal | null>(null);
  const [version, setVersion] = useState<UwVersion | null>(null);

  // Sensitivity grid toggle
  const [sensitivityMode, setSensitivityMode] = useState<"irr" | "em">("irr");

  // Local assumption state
  const [assumptions, setAssumptions] = useState<LocalAssumptions>({
    hold_period_years: 5,
    exit_cap_rate_mode: "manual",
    exit_cap_rate_value: 6.5,
    exit_cap_rate_spread_bps: 50,
    cost_of_sale_pct: 1.5,
    vacancy_rate: 0,
    mgmt_fee_pct: 0,
    capex_per_sf: 0,
  });

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [projectRes, propertyRes, dealRes] = await Promise.all([
        supabase
          .from("uw_projects")
          .select("*")
          .eq("id", params.projectId)
          .single(),
        supabase
          .from("uw_properties")
          .select("*")
          .eq("id", params.propertyId)
          .single(),
        supabase
          .from("uw_deals")
          .select("*")
          .eq("id", params.dealId)
          .single(),
      ]);

      if (projectRes.error) throw new Error(projectRes.error.message);
      if (propertyRes.error) throw new Error(propertyRes.error.message);
      if (dealRes.error) throw new Error(dealRes.error.message);

      setProject(projectRes.data as UwProject);
      setProperty(propertyRes.data as UwProperty);
      setDeal(dealRes.data as UwDeal);

      // Fetch latest version
      const versionRes = await supabase
        .from("uw_versions")
        .select("*")
        .eq("deal_id", params.dealId)
        .order("version_number", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (versionRes.error) throw new Error(versionRes.error.message);
      const v = versionRes.data as UwVersion | null;
      setVersion(v);

      // Initialize assumptions from version if available
      if (v?.assumptions) {
        const a = v.assumptions;
        setAssumptions({
          hold_period_years: a.hold_period_years ?? 5,
          exit_cap_rate_mode: a.exit_cap_rate_mode ?? "manual",
          exit_cap_rate_value: +((a.exit_cap_rate_final ?? 0.065) * 100).toFixed(1),
          exit_cap_rate_spread_bps: a.exit_cap_rate_spread_bps ?? 50,
          cost_of_sale_pct: +((a.cost_of_sale_pct ?? 0.015) * 100).toFixed(1),
          vacancy_rate: +((a.vacancy_rate ?? 0) * 100).toFixed(1),
          mgmt_fee_pct: +((a.mgmt_fee_pct ?? 0) * 100).toFixed(1),
          capex_per_sf: a.capex_per_sf ?? 0,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [params.projectId, params.propertyId, params.dealId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // ─── Loading / Error States ──────────────────────────────────────────────

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-32">
          <Loader2 className="w-6 h-6 animate-spin text-muted" />
        </div>
      </Shell>
    );
  }

  if (error || !project || !property || !deal) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center py-32 gap-3">
          <AlertCircle className="w-8 h-8 text-red-500" />
          <p className="text-sm text-muted">{error ?? "Data not found"}</p>
        </div>
      </Shell>
    );
  }

  // ─── Breadcrumbs ─────────────────────────────────────────────────────────

  const breadcrumbs = (
    <nav className="flex items-center gap-1.5 text-sm text-muted mb-6 flex-wrap">
      <Link href="/" className="hover:text-foreground transition-colors">
        Projects
      </Link>
      <ChevronRight className="w-3.5 h-3.5 shrink-0" />
      <Link
        href={`/projects/${project.id}`}
        className="hover:text-foreground transition-colors"
      >
        {project.name}
      </Link>
      <ChevronRight className="w-3.5 h-3.5 shrink-0" />
      <Link
        href={`/projects/${project.id}/properties/${property.id}`}
        className="hover:text-foreground transition-colors"
      >
        {property.name}
      </Link>
      <ChevronRight className="w-3.5 h-3.5 shrink-0" />
      <Link
        href={`/projects/${project.id}/properties/${property.id}/deals/${deal.id}`}
        className="hover:text-foreground transition-colors"
      >
        {deal.label ?? "Deal"}
      </Link>
      <ChevronRight className="w-3.5 h-3.5 shrink-0" />
      <span className="text-foreground font-medium">Pro Forma</span>
    </nav>
  );

  // ─── Empty State ─────────────────────────────────────────────────────────

  if (!version) {
    return (
      <Shell>
        {breadcrumbs}
        <div className="flex flex-col items-center justify-center py-32 gap-4">
          <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center">
            <FileX className="w-8 h-8 text-gray-400" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">
            No underwriting data yet
          </h2>
          <p className="text-sm text-muted max-w-md text-center">
            Run the underwriting engine to generate the pro forma. Once
            complete, the full cash flow model, exit analysis, sensitivity
            grid, and pricing summary will appear here.
          </p>
          <Link
            href={`/projects/${project.id}/properties/${property.id}/deals/${deal.id}`}
            className="mt-2 px-4 py-2 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent/90 transition-colors"
          >
            Back to Deal
          </Link>
        </div>
      </Shell>
    );
  }

  // ─── Extract version data ────────────────────────────────────────────────

  const rentSchedule: RentScheduleYear[] = version.rent_schedule ?? [];
  const cashFlow: CashFlowYear[] = version.cash_flow_model ?? [];
  const exitAnalysis: ExitAnalysis = version.exit_analysis;
  const sensitivityGrid: SensitivityGrid = version.sensitivity_grid;
  const pricingOutput: PricingOutput = version.pricing_output;
  const scenarios = version.assumptions?.scenarios;
  const targetIrr = project.target_irr;

  // Merge rent schedule and cash flow by year for the combined table
  const mergedYears = cashFlow.map((cf) => {
    const rs = rentSchedule.find((r) => r.year === cf.year);
    return { ...cf, ...rs, noi: cf.noi, cumulative_noi: cf.cumulative_noi };
  });

  return (
    <Shell>
      {breadcrumbs}

      {/* Page Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-foreground tracking-tight">
            Pro Forma
          </h1>
          <p className="text-sm text-muted mt-1">
            {property.name} &mdash; {deal.label ?? "Deal"} &mdash; Version{" "}
            {version.version_number}
          </p>
        </div>
        <Link
          href={`/projects/${project.id}/properties/${property.id}/deals/${deal.id}`}
          className="text-sm text-accent hover:underline"
        >
          Back to Deal
        </Link>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-8">
        {/* ────────────────────────────────────────────────────────────────── */}
        {/* 1. Assumption Panel (Sidebar)                                     */}
        {/* ────────────────────────────────────────────────────────────────── */}
        <aside className="space-y-6">
          <div className="bg-card border border-border rounded-xl p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-5">
              <SlidersHorizontal className="w-4 h-4 text-accent" />
              <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                Assumptions
              </h2>
            </div>

            <div className="space-y-4">
              {/* Hold Period */}
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  Hold Period (years)
                </label>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={assumptions.hold_period_years}
                  onChange={(e) =>
                    setAssumptions((prev) => ({
                      ...prev,
                      hold_period_years: parseInt(e.target.value) || 5,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
              </div>

              {/* Exit Cap Rate Mode */}
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  Exit Cap Rate Mode
                </label>
                <select
                  value={assumptions.exit_cap_rate_mode}
                  onChange={(e) =>
                    setAssumptions((prev) => ({
                      ...prev,
                      exit_cap_rate_mode: e.target.value as ExitCapRateMode,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                >
                  <option value="manual">Manual</option>
                  <option value="spread_to_entry">Spread to Entry</option>
                  <option value="comp_derived">Comp-Derived</option>
                </select>
              </div>

              {/* Exit Cap Rate Value */}
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  Exit Cap Rate (%)
                </label>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={20}
                  value={assumptions.exit_cap_rate_value}
                  onChange={(e) =>
                    setAssumptions((prev) => ({
                      ...prev,
                      exit_cap_rate_value: parseFloat(e.target.value) || 0,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
              </div>

              {/* Exit Cap Rate Spread (conditional) */}
              {assumptions.exit_cap_rate_mode === "spread_to_entry" && (
                <div>
                  <label className="block text-xs font-medium text-muted mb-1">
                    Exit Cap Rate Spread (bps)
                  </label>
                  <input
                    type="number"
                    step={5}
                    min={0}
                    max={500}
                    value={assumptions.exit_cap_rate_spread_bps}
                    onChange={(e) =>
                      setAssumptions((prev) => ({
                        ...prev,
                        exit_cap_rate_spread_bps:
                          parseInt(e.target.value) || 0,
                      }))
                    }
                    className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                  />
                </div>
              )}

              {/* Cost of Sale */}
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  Cost of Sale (%)
                </label>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={10}
                  value={assumptions.cost_of_sale_pct}
                  onChange={(e) =>
                    setAssumptions((prev) => ({
                      ...prev,
                      cost_of_sale_pct: parseFloat(e.target.value) || 0,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
              </div>

              {/* Vacancy Rate */}
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  Vacancy Rate (%)
                </label>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={50}
                  value={assumptions.vacancy_rate}
                  onChange={(e) =>
                    setAssumptions((prev) => ({
                      ...prev,
                      vacancy_rate: parseFloat(e.target.value) || 0,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
              </div>

              {/* Management Fee */}
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  Management Fee (%)
                </label>
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={20}
                  value={assumptions.mgmt_fee_pct}
                  onChange={(e) =>
                    setAssumptions((prev) => ({
                      ...prev,
                      mgmt_fee_pct: parseFloat(e.target.value) || 0,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
              </div>

              {/* CapEx per SF */}
              <div>
                <label className="block text-xs font-medium text-muted mb-1">
                  CapEx per SF ($)
                </label>
                <input
                  type="number"
                  step={0.25}
                  min={0}
                  max={50}
                  value={assumptions.capex_per_sf}
                  onChange={(e) =>
                    setAssumptions((prev) => ({
                      ...prev,
                      capex_per_sf: parseFloat(e.target.value) || 0,
                    }))
                  }
                  className="w-full px-3 py-2 text-sm border border-border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
              </div>

              {/* Recalculate Button */}
              <button
                onClick={() => {
                  toast.info(
                    "Recalculation will be handled by the Python engine"
                  );
                }}
                className="w-full mt-2 flex items-center justify-center gap-2 px-4 py-2.5 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent/90 transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                Recalculate
              </button>
            </div>
          </div>
        </aside>

        {/* ────────────────────────────────────────────────────────────────── */}
        {/* Main Content Area                                                 */}
        {/* ────────────────────────────────────────────────────────────────── */}
        <div className="space-y-8 min-w-0">
          {/* ────────────────────────────────────────────────────────────── */}
          {/* 2. Pro Forma Operating Statement (Spreadsheet Style)          */}
          {/* ────────────────────────────────────────────────────────────── */}
          <section className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2">
              <Table2 className="w-4 h-4 text-accent" />
              <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                Pro Forma Operating Statement
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-gray-100 dark:bg-gray-900/60 border-b-2 border-border">
                    <th className="text-left px-4 py-3 font-bold text-foreground whitespace-nowrap sticky left-0 bg-gray-100 dark:bg-gray-900/60 z-10 min-w-[220px]">
                      &nbsp;
                    </th>
                    {mergedYears.map((row) => (
                      <th
                        key={row.year}
                        className="text-right px-4 py-3 font-bold text-foreground whitespace-nowrap min-w-[120px]"
                      >
                        Year {row.year}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {/* ── REVENUE SECTION ────────────────────────────────── */}
                  <tr className="bg-blue-50/60 dark:bg-blue-950/20">
                    <td colSpan={mergedYears.length + 1} className="px-4 py-2 font-bold text-xs uppercase tracking-widest text-blue-700 dark:text-blue-400 sticky left-0 bg-blue-50/60 dark:bg-blue-950/20 z-10">
                      Revenue
                    </td>
                  </tr>

                  {/* Lease Status */}
                  <tr>
                    <td className="px-4 py-1.5 text-xs text-muted whitespace-nowrap sticky left-0 bg-card z-10 pl-8">
                      Lease Status
                    </td>
                    {mergedYears.map((row) => {
                      const status = row.lease_status ?? "in_place";
                      const labels: Record<string, [string, string]> = {
                        in_place: ["In Place", "text-green-600 bg-green-50"],
                        option_period: ["Option", "text-blue-600 bg-blue-50"],
                        vacant_downtime: ["Downtime", "text-red-600 bg-red-50"],
                        releasing: ["Re-Leasing", "text-amber-600 bg-amber-50"],
                        re_leased: ["Re-Leased", "text-green-600 bg-green-50"],
                      };
                      const [label, cls] = labels[status] ?? ["—", "text-muted"];
                      return (
                        <td key={row.year} className="text-right px-4 py-1.5 whitespace-nowrap">
                          <span className={cn("text-xs font-medium px-2 py-0.5 rounded-full", cls)}>
                            {label}
                          </span>
                        </td>
                      );
                    })}
                  </tr>

                  {/* Base Rent / Scheduled Rent */}
                  <ProFormaRow
                    label="Base Rent (Scheduled)"
                    values={mergedYears.map((row) => row.scheduled_rent)}
                    indent
                  />

                  {/* Rent Bump */}
                  <ProFormaRow
                    label="Rent Escalation"
                    values={mergedYears.map((row) => row.bump_applied || "")}
                    isText
                    indent
                    muted
                  />

                  {/* Rent / SF */}
                  <ProFormaRow
                    label="Rent per SF"
                    values={mergedYears.map((row) => row.rent_per_sf)}
                    format="currency-compact"
                    indent
                    muted
                  />

                  {/* Total Revenue subtotal */}
                  <ProFormaRow
                    label="Gross Potential Revenue"
                    values={mergedYears.map((row) => row.scheduled_rent)}
                    subtotal
                    topBorder
                  />

                  {/* Vacancy / Credit Loss */}
                  <ProFormaRow
                    label="Less: Vacancy & Credit Loss"
                    values={mergedYears.map((row) => row.vacancy_loss)}
                    negative
                    indent
                  />

                  {/* EGI */}
                  <ProFormaRow
                    label="Effective Gross Income (EGI)"
                    values={mergedYears.map((row) => row.effective_gross_income)}
                    bold
                    topBorder
                    highlight="green"
                  />

                  {/* ── EXPENSE SECTION ────────────────────────────────── */}
                  <tr className="bg-red-50/50 dark:bg-red-950/15">
                    <td colSpan={mergedYears.length + 1} className="px-4 py-2 font-bold text-xs uppercase tracking-widest text-red-700 dark:text-red-400 sticky left-0 bg-red-50/50 dark:bg-red-950/15 z-10">
                      Operating Expenses
                    </td>
                  </tr>

                  {/* Management Fee */}
                  <ProFormaRow
                    label="Management Fee"
                    values={mergedYears.map((row) => row.mgmt_fee)}
                    negative
                    indent
                  />

                  {/* CapEx Reserve */}
                  <ProFormaRow
                    label="CapEx / Reserves"
                    values={mergedYears.map((row) => row.capex_reserve)}
                    negative
                    indent
                  />

                  {/* Leasing Costs (TI + LC) */}
                  <ProFormaRow
                    label="Leasing Costs (TI + LC)"
                    values={mergedYears.map((row) => row.leasing_costs ?? 0)}
                    negative
                    indent
                  />

                  {/* Landlord OpEx (NNN passthrough) */}
                  <ProFormaRow
                    label="Landlord Operating Expenses"
                    values={mergedYears.map((row) => row.landlord_opex)}
                    negative
                    indent
                  />

                  {/* Total OpEx subtotal */}
                  <ProFormaRow
                    label="Total Operating Expenses"
                    values={mergedYears.map((row) => row.total_operating_expenses)}
                    negative
                    subtotal
                    topBorder
                  />

                  {/* ── NET OPERATING INCOME ───────────────────────────── */}
                  <tr className="bg-accent/8 border-t-2 border-b-2 border-border">
                    <td className="px-4 py-3 font-black text-foreground whitespace-nowrap sticky left-0 bg-accent/8 z-10 text-base">
                      Net Operating Income (NOI)
                    </td>
                    {mergedYears.map((row) => (
                      <td
                        key={row.year}
                        className="text-right px-4 py-3 font-black text-foreground tabular-nums whitespace-nowrap text-base"
                      >
                        {formatCurrency(row.noi)}
                      </td>
                    ))}
                  </tr>

                  {/* ── RETURNS SECTION ─────────────────────────────────── */}
                  <tr className="bg-gray-50/60 dark:bg-gray-900/20">
                    <td colSpan={mergedYears.length + 1} className="px-4 py-2 font-bold text-xs uppercase tracking-widest text-gray-500 dark:text-gray-400 sticky left-0 bg-gray-50/60 dark:bg-gray-900/20 z-10">
                      Returns Analysis
                    </td>
                  </tr>

                  {/* Cumulative NOI */}
                  <ProFormaRow
                    label="Cumulative NOI"
                    values={mergedYears.map((row) => row.cumulative_noi)}
                    indent
                    muted
                  />

                  {/* YoY NOI Growth */}
                  <ProFormaRow
                    label="NOI Growth (YoY)"
                    values={mergedYears.map((row, i) => {
                      if (i === 0) return null;
                      const prev = mergedYears[i - 1].noi;
                      if (!prev) return null;
                      return ((row.noi - prev) / prev);
                    })}
                    format="percent"
                    indent
                    muted
                  />
                </tbody>
              </table>
            </div>
          </section>

          {/* ────────────────────────────────────────────────────────────── */}
          {/* 3. Exit Analysis Panel                                        */}
          {/* ────────────────────────────────────────────────────────────── */}
          <section className="bg-card border border-border rounded-xl shadow-sm">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-accent" />
              <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                Exit Analysis
              </h2>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 divide-x divide-border">
              <ExitMetric
                label="Gross Sale Price"
                value={formatCurrency(exitAnalysis.gross_sale_price)}
              />
              <ExitMetric
                label="Cost of Sale"
                value={formatCurrency(exitAnalysis.cost_of_sale)}
                negative
              />
              <ExitMetric
                label="Net Proceeds"
                value={formatCurrency(exitAnalysis.net_proceeds)}
                highlight
              />
              <ExitMetric
                label="Equity Multiple"
                value={formatMultiple(exitAnalysis.equity_multiple)}
                highlight
              />
              <ExitMetric
                label="Unleveraged IRR"
                value={formatIrr(exitAnalysis.unleveraged_irr)}
                highlight
              />
            </div>
          </section>

          {/* ────────────────────────────────────────────────────────────── */}
          {/* 4. Sensitivity Grid (Heat-Mapped)                             */}
          {/* ────────────────────────────────────────────────────────────── */}
          <section className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Grid3X3 className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                  Sensitivity Analysis
                </h2>
              </div>
              <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
                <button
                  onClick={() => setSensitivityMode("irr")}
                  className={cn(
                    "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                    sensitivityMode === "irr"
                      ? "bg-white dark:bg-gray-700 text-foreground shadow-sm"
                      : "text-muted hover:text-foreground"
                  )}
                >
                  IRR
                </button>
                <button
                  onClick={() => setSensitivityMode("em")}
                  className={cn(
                    "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                    sensitivityMode === "em"
                      ? "bg-white dark:bg-gray-700 text-foreground shadow-sm"
                      : "text-muted hover:text-foreground"
                  )}
                >
                  Equity Multiple
                </button>
              </div>
            </div>
            <div className="overflow-x-auto p-5">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-semibold text-muted">
                      Hold \ Exit Cap
                    </th>
                    {sensitivityGrid.exit_cap_rates.map((cap) => (
                      <th
                        key={cap}
                        className="px-3 py-2 text-center text-xs font-semibold text-muted whitespace-nowrap"
                      >
                        {(cap * 100).toFixed(1)}%
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sensitivityGrid.hold_periods.map((hp, rowIdx) => (
                    <tr key={hp}>
                      <td className="px-3 py-2 text-xs font-semibold text-muted whitespace-nowrap">
                        {hp} yr{hp !== 1 ? "s" : ""}
                      </td>
                      {(sensitivityMode === "irr"
                        ? sensitivityGrid.irr_matrix[rowIdx]
                        : sensitivityGrid.em_matrix[rowIdx]
                      ).map((val, colIdx) => (
                        <td key={colIdx} className="px-1 py-1 text-center">
                          <div
                            className={cn(
                              "rounded-md px-2 py-1.5 text-xs font-semibold tabular-nums",
                              sensitivityMode === "irr"
                                ? irrHeatColor(val, targetIrr)
                                : emHeatColor(val)
                            )}
                          >
                            {sensitivityMode === "irr"
                              ? formatIrr(val)
                              : formatMultiple(val)}
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {targetIrr != null && sensitivityMode === "irr" && (
                <p className="text-xs text-muted mt-3">
                  Target IRR: {formatIrr(targetIrr)} &mdash; Green = above
                  target, Yellow = near target, Red = below target
                </p>
              )}
            </div>
          </section>

          {/* ────────────────────────────────────────────────────────────── */}
          {/* 5. Three-Scenario Panel (Bear / Base / Bull)                   */}
          {/* ────────────────────────────────────────────────────────────── */}
          {scenarios && (
            <section>
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="w-4 h-4 text-accent" />
                <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                  Scenario Analysis
                </h2>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <ScenarioCard
                  label="Bear"
                  icon={<TrendingDown className="w-5 h-5" />}
                  accentClass="border-red-200 bg-red-50/50 dark:bg-red-950/20 dark:border-red-900"
                  iconBg="bg-red-100 text-red-600 dark:bg-red-900/50 dark:text-red-400"
                  scenario={scenarios.bear}
                  sensitivityGrid={sensitivityGrid}
                  targetIrr={targetIrr}
                />
                <ScenarioCard
                  label="Base"
                  icon={<Minus className="w-5 h-5" />}
                  accentClass="border-blue-200 bg-blue-50/50 dark:bg-blue-950/20 dark:border-blue-900"
                  iconBg="bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400"
                  scenario={scenarios.base}
                  sensitivityGrid={sensitivityGrid}
                  targetIrr={targetIrr}
                />
                <ScenarioCard
                  label="Bull"
                  icon={<TrendingUp className="w-5 h-5" />}
                  accentClass="border-green-200 bg-green-50/50 dark:bg-green-950/20 dark:border-green-900"
                  iconBg="bg-green-100 text-green-600 dark:bg-green-900/50 dark:text-green-400"
                  scenario={scenarios.bull}
                  sensitivityGrid={sensitivityGrid}
                  targetIrr={targetIrr}
                />
              </div>
            </section>
          )}

          {/* ────────────────────────────────────────────────────────────── */}
          {/* 6. Pricing Summary                                            */}
          {/* ────────────────────────────────────────────────────────────── */}
          <section className="bg-card border border-border rounded-xl shadow-sm overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2">
              <Target className="w-4 h-4 text-accent" />
              <h2 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                Pricing Summary
              </h2>
            </div>

            {/* Key Prices */}
            <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border">
              <div className="px-5 py-4">
                <p className="text-xs text-muted font-medium mb-1">
                  Walk-Away Price
                </p>
                <p className="text-xl font-bold text-red-600 tabular-nums">
                  {formatCurrency(pricingOutput.walk_away_price)}
                </p>
              </div>
              <div className="px-5 py-4">
                <p className="text-xs text-muted font-medium mb-1">
                  Target Price
                </p>
                <p className="text-xl font-bold text-foreground tabular-nums">
                  {formatCurrency(pricingOutput.target_price)}
                </p>
              </div>
              <div className="px-5 py-4">
                <p className="text-xs text-muted font-medium mb-1">
                  Upside Price
                </p>
                <p className="text-xl font-bold text-green-600 tabular-nums">
                  {formatCurrency(pricingOutput.upside_price)}
                </p>
              </div>
            </div>

            {/* Cap Rate Sensitivity Table */}
            {pricingOutput.cap_rate_sensitivity &&
              pricingOutput.cap_rate_sensitivity.length > 0 && (
                <div className="border-t border-border">
                  <div className="px-5 py-3 bg-gray-50/50 dark:bg-gray-900/30">
                    <p className="text-xs font-semibold text-muted uppercase tracking-wider">
                      Cap Rate Sensitivity
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/50">
                          <th className="px-4 py-2 text-left text-xs font-semibold text-muted">
                            Cap Rate
                          </th>
                          <th className="px-4 py-2 text-right text-xs font-semibold text-muted">
                            Price
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {pricingOutput.cap_rate_sensitivity.map(
                          (row, idx) => (
                            <tr
                              key={idx}
                              className={cn(
                                "border-b border-border/30",
                                idx % 2 === 1 &&
                                  "bg-gray-50/30 dark:bg-gray-900/10"
                              )}
                            >
                              <td className="px-4 py-2 text-foreground tabular-nums">
                                {(row.cap_rate * 100).toFixed(1)}%
                              </td>
                              <td className="px-4 py-2 text-right text-foreground font-medium tabular-nums">
                                {formatCurrency(row.price)}
                              </td>
                            </tr>
                          )
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
          </section>
        </div>
      </div>
    </Shell>
  );
}

// ─── Pro Forma Row Component ─────────────────────────────────────────────────

function ProFormaRow({
  label,
  values,
  indent = false,
  bold = false,
  subtotal = false,
  negative = false,
  muted = false,
  topBorder = false,
  isText = false,
  highlight,
  format = "currency",
}: {
  label: string;
  values: (number | string | null | undefined)[];
  indent?: boolean;
  bold?: boolean;
  subtotal?: boolean;
  negative?: boolean;
  muted?: boolean;
  topBorder?: boolean;
  isText?: boolean;
  highlight?: "green" | "blue";
  format?: "currency" | "currency-compact" | "percent";
}) {
  const rowBg = highlight === "green"
    ? "bg-green-50/40 dark:bg-green-950/15"
    : highlight === "blue"
    ? "bg-blue-50/30 dark:bg-blue-950/10"
    : "";

  const labelBg = highlight === "green"
    ? "bg-green-50/40 dark:bg-green-950/15"
    : highlight === "blue"
    ? "bg-blue-50/30 dark:bg-blue-950/10"
    : subtotal
    ? "bg-gray-50/50 dark:bg-gray-900/20"
    : "bg-card";

  return (
    <tr
      className={cn(
        "border-b border-border/30 hover:bg-gray-50/50 dark:hover:bg-gray-900/30",
        topBorder && "border-t border-border",
        rowBg
      )}
    >
      <td
        className={cn(
          "px-4 py-2 whitespace-nowrap sticky left-0 z-10",
          labelBg,
          indent ? "pl-8" : "pl-4",
          bold || subtotal ? "font-bold text-foreground" : "",
          muted && !bold ? "text-muted font-normal text-xs" : "font-medium text-foreground"
        )}
      >
        {label}
      </td>
      {values.map((val, i) => {
        let display: string;
        if (isText) {
          display = val ? String(val) : "\u2014";
        } else if (val == null || val === "") {
          display = "\u2014";
        } else if (format === "percent") {
          display = `${((val as number) * 100).toFixed(1)}%`;
        } else if (format === "currency-compact") {
          display = formatCurrencyCompact(val as number);
        } else {
          const num = val as number;
          if (negative && num > 0) {
            display = `(${formatCurrency(num)})`;
          } else {
            display = formatCurrency(num);
          }
        }

        return (
          <td
            key={i}
            className={cn(
              "text-right px-4 py-2 tabular-nums whitespace-nowrap",
              bold || subtotal ? "font-bold" : "",
              negative && val && (val as number) > 0 ? "text-red-500" : "",
              muted && !bold ? "text-muted text-xs" : "text-foreground"
            )}
          >
            {display}
          </td>
        );
      })}
    </tr>
  );
}

// ─── Sub-Components ──────────────────────────────────────────────────────────

function ExitMetric({
  label,
  value,
  highlight = false,
  negative = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="px-5 py-4">
      <p className="text-xs text-muted font-medium mb-1">{label}</p>
      <p
        className={cn(
          "text-lg font-bold tabular-nums",
          highlight
            ? "text-foreground"
            : negative
              ? "text-red-500"
              : "text-foreground"
        )}
      >
        {negative && value !== "\u2014" ? `(${value})` : value}
      </p>
    </div>
  );
}

function ScenarioCard({
  label,
  icon,
  accentClass,
  iconBg,
  scenario,
  sensitivityGrid,
  targetIrr,
}: {
  label: string;
  icon: React.ReactNode;
  accentClass: string;
  iconBg: string;
  scenario: { exit_cap_rate: number; hold_period_years: number };
  sensitivityGrid: SensitivityGrid;
  targetIrr: number | null;
}) {
  // Look up IRR and EM from the sensitivity grid
  const holdIdx = sensitivityGrid.hold_periods.indexOf(
    scenario.hold_period_years
  );
  const capIdx = sensitivityGrid.exit_cap_rates.findIndex(
    (c) => Math.abs(c - scenario.exit_cap_rate) < 0.0001
  );

  const irr =
    holdIdx >= 0 && capIdx >= 0
      ? sensitivityGrid.irr_matrix[holdIdx]?.[capIdx] ?? null
      : null;
  const em =
    holdIdx >= 0 && capIdx >= 0
      ? sensitivityGrid.em_matrix[holdIdx]?.[capIdx] ?? null
      : null;

  return (
    <div
      className={cn(
        "border rounded-xl p-5 transition-shadow hover:shadow-md",
        accentClass
      )}
    >
      <div className="flex items-center gap-3 mb-4">
        <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", iconBg)}>
          {icon}
        </div>
        <h3 className="text-base font-bold text-foreground">{label}</h3>
      </div>
      <div className="space-y-3">
        <div className="flex justify-between">
          <span className="text-xs text-muted">Exit Cap Rate</span>
          <span className="text-sm font-semibold text-foreground tabular-nums">
            {(scenario.exit_cap_rate * 100).toFixed(1)}%
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-xs text-muted">Hold Period</span>
          <span className="text-sm font-semibold text-foreground tabular-nums">
            {scenario.hold_period_years} yr
            {scenario.hold_period_years !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="h-px bg-border/50 my-1" />
        <div className="flex justify-between">
          <span className="text-xs text-muted">IRR</span>
          <span
            className={cn(
              "text-sm font-bold tabular-nums",
              irr != null && targetIrr != null
                ? irr >= targetIrr
                  ? "text-green-600"
                  : "text-red-600"
                : "text-foreground"
            )}
          >
            {irr != null ? formatIrr(irr) : "\u2014"}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-xs text-muted">Equity Multiple</span>
          <span className="text-sm font-bold text-foreground tabular-nums">
            {em != null ? formatMultiple(em) : "\u2014"}
          </span>
        </div>
      </div>
    </div>
  );
}
