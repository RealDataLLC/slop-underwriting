"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ChevronRight,
  Plus,
  Loader2,
  FileBarChart,
  AlertCircle,
} from "lucide-react";
import { Shell } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import {
  cn,
  formatDate,
  dealStatusLabel,
  dealStatusColor,
  recommendationBg,
  riskScoreColor,
  riskTier,
} from "@/lib/utils";
import type { UwProject, UwProperty, UwDeal } from "@/lib/types";
import { toast } from "sonner";

export default function PropertyPage() {
  const params = useParams<{ projectId: string; propertyId: string }>();
  const router = useRouter();
  const { projectId, propertyId } = params;

  const [project, setProject] = useState<UwProject | null>(null);
  const [property, setProperty] = useState<UwProperty | null>(null);
  const [deals, setDeals] = useState<UwDeal[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    async function load() {
      setLoading(true);
      const [projRes, propRes, dealsRes] = await Promise.all([
        supabase.from("uw_projects").select("*").eq("id", projectId).single(),
        supabase.from("uw_properties").select("*").eq("id", propertyId).single(),
        supabase
          .from("uw_deals")
          .select("*")
          .eq("property_id", propertyId)
          .order("created_at", { ascending: false }),
      ]);

      if (projRes.error) {
        toast.error("Failed to load project");
        console.error(projRes.error);
      } else {
        setProject(projRes.data);
      }

      if (propRes.error) {
        toast.error("Failed to load property");
        console.error(propRes.error);
      } else {
        setProperty(propRes.data);
      }

      if (dealsRes.error) {
        toast.error("Failed to load deals");
        console.error(dealsRes.error);
      } else {
        setDeals(dealsRes.data ?? []);
      }

      setLoading(false);
    }

    load();
  }, [projectId, propertyId]);

  async function createDeal() {
    setCreating(true);
    const { data, error } = await supabase
      .from("uw_deals")
      .insert({
        property_id: propertyId,
        status: "uploading",
        human_review_required: false,
        created_by: null,
        label: null,
        review_cleared_by: null,
        review_cleared_at: null,
        review_summary: null,
        deal_schema: null,
        underwriting_output: null,
        assumption_overrides: null,
        memo_pdf_key: null,
        proforma_excel_key: null,
        recommendation: null,
        recommendation_rationale: null,
        risk_score: null,
      })
      .select()
      .single();

    if (error) {
      toast.error("Failed to create deal");
      console.error(error);
      setCreating(false);
      return;
    }

    toast.success("Underwriting run created");
    router.push(
      `/projects/${projectId}/properties/${propertyId}/deals/${data.id}`
    );
  }

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 text-accent animate-spin" />
        </div>
      </Shell>
    );
  }

  if (!property) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center py-24 gap-2 text-muted">
          <AlertCircle className="w-6 h-6" />
          <p className="text-sm">Property not found</p>
        </div>
      </Shell>
    );
  }

  const locationParts = [property.city, property.state]
    .filter(Boolean)
    .join(", ");

  return (
    <Shell>
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-muted mb-6">
        <Link href="/" className="hover:text-foreground transition-colors">
          Projects
        </Link>
        <ChevronRight className="w-3.5 h-3.5" />
        <Link
          href={`/projects/${projectId}`}
          className="hover:text-foreground transition-colors"
        >
          {project?.name ?? "Project"}
        </Link>
        <ChevronRight className="w-3.5 h-3.5" />
        <span className="text-foreground font-medium">{property.name}</span>
      </nav>

      {/* Property Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              {property.name}
            </h1>
            {property.property_type && (
              <Badge>{property.property_type}</Badge>
            )}
          </div>
          {property.property_address && (
            <p className="text-sm text-muted">{property.property_address}</p>
          )}
          {locationParts && (
            <p className="text-sm text-muted">{locationParts}</p>
          )}
        </div>
        <button
          onClick={createDeal}
          disabled={creating}
          className={cn(
            "flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white bg-accent hover:bg-accent/90 transition-colors",
            creating && "opacity-50 cursor-not-allowed"
          )}
        >
          {creating ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Plus className="w-4 h-4" />
          )}
          New Underwriting Run
        </button>
      </div>

      {/* Deal History */}
      <section>
        <h2 className="text-lg font-semibold mb-4">Deal History</h2>
        {deals.length === 0 ? (
          <div className="bg-card border border-border rounded-lg p-12 text-center">
            <FileBarChart className="w-8 h-8 text-muted mx-auto mb-3" />
            <p className="text-sm text-muted">
              No underwriting runs yet. Click "New Underwriting Run" to get
              started.
            </p>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-lg divide-y divide-border">
            {deals.map((deal) => {
              const recVariant =
                deal.recommendation === "go"
                  ? "go"
                  : deal.recommendation === "watch"
                  ? "watch"
                  : deal.recommendation === "pass"
                  ? "pass"
                  : undefined;

              return (
                <Link
                  key={deal.id}
                  href={`/projects/${projectId}/properties/${propertyId}/deals/${deal.id}`}
                  className="flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors first:rounded-t-lg last:rounded-b-lg"
                >
                  <div className="flex items-center gap-4">
                    <div>
                      <p className="text-sm font-medium">
                        {deal.label || "Untitled"}
                      </p>
                      <p className="text-xs text-muted">
                        {formatDate(deal.created_at)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {deal.recommendation && (
                      <Badge variant={recVariant}>
                        {deal.recommendation.charAt(0).toUpperCase() +
                          deal.recommendation.slice(1)}
                      </Badge>
                    )}
                    {deal.risk_score != null && (
                      <span
                        className={cn(
                          "text-sm font-medium tabular-nums",
                          riskScoreColor(deal.risk_score)
                        )}
                      >
                        {deal.risk_score}{" "}
                        <span className="text-xs font-normal">
                          ({riskTier(deal.risk_score)})
                        </span>
                      </span>
                    )}
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
                        dealStatusColor(deal.status)
                      )}
                    >
                      {dealStatusLabel(deal.status)}
                    </span>
                    <ChevronRight className="w-4 h-4 text-muted" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>
    </Shell>
  );
}
