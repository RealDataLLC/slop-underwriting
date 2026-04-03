"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Plus, Building, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { supabase } from "@/lib/supabase";
import { SmartUpload } from "@/components/deals/smart-upload";
import {
  cn,
  formatPercent,
  formatRelativeDate,
  formatDate,
  riskScoreColor,
  riskTier,
} from "@/lib/utils";
import type {
  UwProject,
  UwProperty,
  PropertyType,
  Recommendation,
  ProjectStatus,
} from "@/lib/types";

const PROPERTY_TYPES: PropertyType[] = [
  "QSR",
  "Pharmacy",
  "Dollar",
  "Auto",
  "C-Store",
  "Bank",
  "Medical",
  "Other",
];

const statusLabel: Record<ProjectStatus, string> = {
  active: "Active",
  under_contract: "Under Contract",
  closed: "Closed",
  dead: "Dead",
};

const statusVariant: Record<ProjectStatus, "go" | "watch" | "pass" | "status" | "default"> = {
  active: "go",
  under_contract: "watch",
  closed: "status",
  dead: "pass",
};

const recVariant: Record<Recommendation, "go" | "watch" | "pass"> = {
  go: "go",
  watch: "watch",
  pass: "pass",
};

const recLabel: Record<Recommendation, string> = {
  go: "Go",
  watch: "Watch",
  pass: "Pass",
};

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [project, setProject] = useState<UwProject | null>(null);
  const [properties, setProperties] = useState<UwProperty[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const [formName, setFormName] = useState("");
  const [formAddress, setFormAddress] = useState("");
  const [formCity, setFormCity] = useState("");
  const [formState, setFormState] = useState("");
  const [formZip, setFormZip] = useState("");
  const [formType, setFormType] = useState<PropertyType | "">("");

  const fetchData = useCallback(async () => {
    setLoading(true);

    const [projectRes, propertiesRes] = await Promise.all([
      supabase.from("uw_projects").select("*").eq("id", projectId).single(),
      supabase
        .from("uw_properties")
        .select("*")
        .eq("project_id", projectId)
        .order("updated_at", { ascending: false }),
    ]);

    if (projectRes.error) {
      toast.error("Failed to load project");
      setLoading(false);
      return;
    }

    setProject(projectRes.data);
    setProperties(propertiesRes.data || []);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const resetForm = () => {
    setFormName("");
    setFormAddress("");
    setFormCity("");
    setFormState("");
    setFormZip("");
    setFormType("");
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      toast.error("Property name is required");
      return;
    }

    setCreating(true);

    const { error } = await supabase.from("uw_properties").insert({
      project_id: projectId,
      name: formName.trim(),
      property_address: formAddress.trim() || null,
      city: formCity.trim() || null,
      state: formState.trim() || null,
      zip: formZip.trim() || null,
      property_type: (formType as PropertyType) || null,
      market: null,
      costar_property_id: null,
      created_by: null,
      notes: null,
      is_archived: false,
    });

    setCreating(false);

    if (error) {
      toast.error("Failed to add property");
      return;
    }

    toast.success("Property added");
    setModalOpen(false);
    resetForm();
    fetchData();
  };

  if (loading) {
    return (
      <Shell>
        <div className="animate-pulse space-y-6">
          <div className="h-5 bg-gray-200 rounded w-48" />
          <div className="h-8 bg-gray-200 rounded w-72" />
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="bg-card border border-border rounded-xl p-6">
                <div className="h-5 bg-gray-200 rounded w-2/3 mb-3" />
                <div className="h-4 bg-gray-100 rounded w-full mb-2" />
                <div className="h-4 bg-gray-100 rounded w-1/2" />
              </div>
            ))}
          </div>
        </div>
      </Shell>
    );
  }

  if (!project) {
    return (
      <Shell>
        <div className="text-center py-16">
          <h2 className="text-lg font-semibold text-foreground mb-1">Project not found</h2>
          <p className="text-sm text-muted mb-4">
            The project you are looking for does not exist or has been removed.
          </p>
          <Link
            href="/"
            className="text-sm text-accent hover:underline"
          >
            Back to Projects
          </Link>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-muted mb-6">
        <Link href="/" className="hover:text-foreground transition-colors">
          Projects
        </Link>
        <ChevronRight className="w-3.5 h-3.5" />
        <span className="text-foreground font-medium truncate">{project.name}</span>
      </nav>

      {/* Project Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-semibold text-foreground">{project.name}</h1>
            <Badge variant={statusVariant[project.status]}>
              {statusLabel[project.status]}
            </Badge>
          </div>
          {project.description && (
            <p className="text-sm text-muted mb-3 max-w-2xl">{project.description}</p>
          )}
          <div className="flex items-center gap-5 text-sm text-muted">
            {project.target_cap_rate != null && (
              <span>
                Target Cap Rate:{" "}
                <span className="text-foreground font-medium">
                  {formatPercent(project.target_cap_rate)}
                </span>
              </span>
            )}
            {project.max_cap_rate != null && (
              <span>
                Max Cap Rate:{" "}
                <span className="text-foreground font-medium">
                  {formatPercent(project.max_cap_rate)}
                </span>
              </span>
            )}
            {project.target_irr != null && (
              <span>
                Target IRR:{" "}
                <span className="text-foreground font-medium">
                  {formatPercent(project.target_irr)}
                </span>
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors shrink-0"
        >
          <Plus className="w-4 h-4" />
          Add Property
        </button>
      </div>

      {/* Smart Upload Zone */}
      <div className="mb-8">
        <SmartUpload
          projectId={projectId}
          properties={properties}
          onDealCreated={() => fetchData()}
        />
      </div>

      {/* Properties */}
      {properties.length === 0 ? (
        <EmptyState
          icon={Building}
          title="No properties yet"
          description="Add your first property to begin underwriting analysis."
          action={
            <button
              onClick={() => setModalOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add Property
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {properties.map((property) => (
            <Link
              key={property.id}
              href={`/projects/${projectId}/properties/${property.id}`}
              className="block bg-card border border-border rounded-xl p-6 hover:border-accent/40 hover:shadow-sm transition-all group"
            >
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-semibold text-foreground group-hover:text-accent transition-colors truncate pr-2">
                  {property.name}
                </h3>
                {property.property_type && (
                  <Badge variant="default">{property.property_type}</Badge>
                )}
              </div>

              {(property.property_address || property.city) && (
                <p className="text-sm text-muted mb-3 truncate">
                  {[property.property_address, property.city, property.state]
                    .filter(Boolean)
                    .join(", ")}
                </p>
              )}

              <div className="flex items-center gap-3 mb-3">
                {property.latest_recommendation && (
                  <Badge variant={recVariant[property.latest_recommendation]}>
                    {recLabel[property.latest_recommendation]}
                  </Badge>
                )}
                {property.latest_risk_score != null && (
                  <span className={cn("text-sm font-medium", riskScoreColor(property.latest_risk_score))}>
                    Risk: {property.latest_risk_score} ({riskTier(property.latest_risk_score)})
                  </span>
                )}
              </div>

              <div className="text-xs text-muted pt-3 border-t border-border flex items-center justify-between">
                <span>Updated {formatRelativeDate(property.updated_at)}</span>
                {property.latest_underwritten_at && (
                  <span>UW {formatDate(property.latest_underwritten_at)}</span>
                )}
              </div>
            </Link>
          ))}
        </div>
      )}

      {/* Add Property Modal */}
      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          resetForm();
        }}
        title="Add Property"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Property Name <span className="text-pass">*</span>
            </label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Taco Bell - 123 Main St"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Street Address
            </label>
            <input
              type="text"
              value={formAddress}
              onChange={(e) => setFormAddress(e.target.value)}
              placeholder="123 Main St"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">City</label>
              <input
                type="text"
                value={formCity}
                onChange={(e) => setFormCity(e.target.value)}
                placeholder="Austin"
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">State</label>
              <input
                type="text"
                value={formState}
                onChange={(e) => setFormState(e.target.value)}
                placeholder="TX"
                maxLength={2}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent uppercase"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">ZIP</label>
              <input
                type="text"
                value={formZip}
                onChange={(e) => setFormZip(e.target.value)}
                placeholder="78701"
                maxLength={10}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Property Type
            </label>
            <select
              value={formType}
              onChange={(e) => setFormType(e.target.value as PropertyType | "")}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
            >
              <option value="">Select type...</option>
              {PROPERTY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={() => {
                setModalOpen(false);
                resetForm();
              }}
              className="rounded-lg px-4 py-2 text-sm font-medium text-muted hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={creating}
              className={cn(
                "rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors",
                creating && "opacity-50 cursor-not-allowed"
              )}
            >
              {creating ? "Adding..." : "Add Property"}
            </button>
          </div>
        </form>
      </Modal>
    </Shell>
  );
}
