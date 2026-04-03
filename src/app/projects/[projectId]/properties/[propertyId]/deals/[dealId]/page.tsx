"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ChevronRight,
  Loader2,
  AlertCircle,
  FileText,
  Trash2,
  Download,
  ExternalLink,
  ShieldCheck,
  TrendingUp,
  AlertTriangle,
  Pencil,
  Save,
  SlidersHorizontal,
  ChevronDown,
} from "lucide-react";
import { Shell } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { StatusPipeline } from "@/components/deals/status-pipeline";
import { UploadZone } from "@/components/deals/upload-zone";
import { supabase } from "@/lib/supabase";
import {
  cn,
  formatDate,
  formatCurrency,
  formatPercent,
  dealStatusLabel,
  recommendationBg,
  riskScoreColor,
  riskTier,
} from "@/lib/utils";
import type {
  UwProject,
  UwProperty,
  UwDeal,
  UwDocument,
  UwVersion,
  DocumentType,
  DealSchema,
  DealStatus,
} from "@/lib/types";
import { toast } from "sonner";

const DOCUMENT_TYPE_OPTIONS: { value: DocumentType; label: string }[] = [
  { value: "om", label: "Offering Memorandum" },
  { value: "rent_roll", label: "Rent Roll" },
  { value: "financial_statement", label: "Financial Statement" },
  { value: "lease", label: "Lease" },
  { value: "other", label: "Other" },
];

function formatBytes(bytes: number | null): string {
  if (bytes == null) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DealPage() {
  const params = useParams<{
    projectId: string;
    propertyId: string;
    dealId: string;
  }>();
  const { projectId, propertyId, dealId } = params;

  const [project, setProject] = useState<UwProject | null>(null);
  const [property, setProperty] = useState<UwProperty | null>(null);
  const [deal, setDeal] = useState<UwDeal | null>(null);
  const [documents, setDocuments] = useState<UwDocument[]>([]);
  const [latestVersion, setLatestVersion] = useState<UwVersion | null>(null);
  const [loading, setLoading] = useState(true);
  const [docType, setDocType] = useState<DocumentType>("om");

  const loadData = useCallback(async () => {
    const [projRes, propRes, dealRes, docsRes, versionRes] = await Promise.all([
      supabase.from("uw_projects").select("*").eq("id", projectId).single(),
      supabase.from("uw_properties").select("*").eq("id", propertyId).single(),
      supabase.from("uw_deals").select("*").eq("id", dealId).single(),
      supabase
        .from("uw_documents")
        .select("*")
        .eq("deal_id", dealId)
        .order("created_at", { ascending: false }),
      supabase
        .from("uw_versions")
        .select("*")
        .eq("deal_id", dealId)
        .order("version_number", { ascending: false })
        .limit(1),
    ]);

    if (projRes.data) setProject(projRes.data);
    if (propRes.data) setProperty(propRes.data);
    if (dealRes.data) setDeal(dealRes.data);
    if (docsRes.data) setDocuments(docsRes.data);
    if (versionRes.data && versionRes.data.length > 0)
      setLatestVersion(versionRes.data[0]);

    if (dealRes.error) {
      toast.error("Failed to load deal");
      console.error(dealRes.error);
    }

    setLoading(false);
  }, [projectId, propertyId, dealId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Poll for status updates while extracting or underwriting
  useEffect(() => {
    if (!deal) return;
    if (deal.status !== "extracting" && deal.status !== "underwriting") return;

    const interval = setInterval(async () => {
      const { data } = await supabase
        .from("uw_deals")
        .select("status, recommendation, risk_score")
        .eq("id", dealId)
        .single();

      if (data && data.status !== deal.status) {
        loadData(); // Refresh everything when status changes
        if (data.status === "complete") {
          toast.success("Underwriting complete!");
        } else if (data.status === "review") {
          toast.info("Extraction complete — review required");
        }
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [deal, dealId, loadData]);

  const handleUpload = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        const storagePath = `${propertyId}/${dealId}/${file.name}`;
        const { error: uploadError } = await supabase.storage
          .from("uw-source-documents")
          .upload(storagePath, file);

        if (uploadError) {
          toast.error(`Failed to upload ${file.name}: ${uploadError.message}`);
          console.error(uploadError);
          continue;
        }

        const { error: docError } = await supabase
          .from("uw_documents")
          .insert({
            deal_id: dealId,
            document_type: docType,
            original_filename: file.name,
            storage_key: storagePath,
            file_size_bytes: file.size,
            mime_type: file.type || null,
            extraction_status: "pending",
            extracted_at: null,
            extraction_confidence: null,
            page_classification: null,
            raw_extraction: null,
            extraction_error: null,
          });

        if (docError) {
          toast.error(`Failed to save document record for ${file.name}`);
          console.error(docError);
          continue;
        }

        toast.success(`Uploaded ${file.name}`);
      }

      // Refresh documents list
      const { data } = await supabase
        .from("uw_documents")
        .select("*")
        .eq("deal_id", dealId)
        .order("created_at", { ascending: false });
      if (data) setDocuments(data);
    },
    [propertyId, dealId, docType]
  );

  const handleDeleteDocument = useCallback(
    async (doc: UwDocument) => {
      const { error: storageError } = await supabase.storage
        .from("uw-source-documents")
        .remove([doc.storage_key]);

      if (storageError) {
        toast.error("Failed to delete file from storage");
        console.error(storageError);
        return;
      }

      const { error: dbError } = await supabase
        .from("uw_documents")
        .delete()
        .eq("id", doc.id);

      if (dbError) {
        toast.error("Failed to delete document record");
        console.error(dbError);
        return;
      }

      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
      toast.success("Document deleted");
    },
    []
  );

  const handleRunExtraction = useCallback(async () => {
    setDeal((prev) => (prev ? { ...prev, status: "extracting" } : prev));
    toast.success("Extraction started");

    // Trigger the extraction pipeline via FastAPI
    try {
      const res = await fetch(`http://127.0.0.1:8000/deals/${dealId}/extract`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.text();
        console.error("Extraction trigger failed:", body);
        toast.error("Failed to start extraction engine");
        setDeal((prev) => (prev ? { ...prev, status: "uploading" } : prev));
      }
    } catch (err) {
      console.error("Extraction trigger error:", err);
      toast.error("Could not reach extraction engine");
      setDeal((prev) => (prev ? { ...prev, status: "uploading" } : prev));
    }
  }, [dealId]);

  const handleNavigateBack = useCallback(
    async (targetStatus: DealStatus) => {
      // Only allow navigating back to uploading, review, or complete
      if (targetStatus === "extracting" || targetStatus === "underwriting") return;

      const { error } = await supabase
        .from("uw_deals")
        .update({ status: targetStatus })
        .eq("id", dealId);

      if (error) {
        toast.error("Failed to change status");
        console.error(error);
        return;
      }

      setDeal((prev) => (prev ? { ...prev, status: targetStatus } : prev));

      const labels: Record<string, string> = {
        uploading: "Upload",
        review: "Review",
        complete: "Complete",
      };
      toast.success(`Returned to ${labels[targetStatus] ?? targetStatus}`);
    },
    [dealId]
  );

  const handleClearForUnderwriting = useCallback(async () => {
    const { error } = await supabase
      .from("uw_deals")
      .update({
        status: "underwriting",
        review_cleared_at: new Date().toISOString(),
      })
      .eq("id", dealId);

    if (error) {
      toast.error("Failed to clear for underwriting");
      console.error(error);
      return;
    }

    setDeal((prev) =>
      prev
        ? {
            ...prev,
            status: "underwriting",
            review_cleared_at: new Date().toISOString(),
          }
        : prev
    );
    toast.success("Cleared for underwriting — running engine…");

    // Trigger the underwriting pipeline via FastAPI
    try {
      const res = await fetch(`http://127.0.0.1:8000/deals/${dealId}/underwrite`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.text();
        console.error("Underwriting trigger failed:", body);
        toast.error("Failed to start underwriting engine");
      }
    } catch (err) {
      console.error("Underwriting trigger error:", err);
      toast.error("Could not reach underwriting engine");
    }
  }, [dealId]);

  if (loading) {
    return (
      <Shell>
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 text-accent animate-spin" />
        </div>
      </Shell>
    );
  }

  if (!deal) {
    return (
      <Shell>
        <div className="flex flex-col items-center justify-center py-24 gap-2 text-muted">
          <AlertCircle className="w-6 h-6" />
          <p className="text-sm">Deal not found</p>
        </div>
      </Shell>
    );
  }

  const dealLabel =
    deal.label || `Deal ${formatDate(deal.created_at)}`;

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
        <Link
          href={`/projects/${projectId}/properties/${propertyId}`}
          className="hover:text-foreground transition-colors"
        >
          {property?.name ?? "Property"}
        </Link>
        <ChevronRight className="w-3.5 h-3.5" />
        <span className="text-foreground font-medium">{dealLabel}</span>
      </nav>

      {/* Status Pipeline */}
      <div className="bg-card border border-border rounded-lg p-6 mb-8">
        <StatusPipeline currentStatus={deal.status} onNavigate={handleNavigateBack} />
      </div>

      {/* Status-specific content */}
      {deal.status === "uploading" && (
        <UploadingSection
          documents={documents}
          docType={docType}
          onDocTypeChange={setDocType}
          onUpload={handleUpload}
          onDelete={handleDeleteDocument}
          onRunExtraction={handleRunExtraction}
        />
      )}

      {deal.status === "extracting" && (
        <div className="bg-card border border-border rounded-lg p-12 text-center">
          <Loader2 className="w-8 h-8 text-accent animate-spin mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-1">Extracting Data</h3>
          <p className="text-sm text-muted">
            The extraction pipeline is processing your documents. This page will
            update when extraction is complete.
          </p>
        </div>
      )}

      {deal.status === "review" && (
        <ReviewSection
          dealSchema={deal.deal_schema}
          dealId={dealId}
          onClear={handleClearForUnderwriting}
          onSchemaUpdated={(schema) =>
            setDeal((prev) => (prev ? { ...prev, deal_schema: schema } : prev))
          }
        />
      )}

      {deal.status === "underwriting" && (
        <div className="bg-card border border-border rounded-lg p-12 text-center">
          <Loader2 className="w-8 h-8 text-accent animate-spin mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-1">Underwriting in Progress</h3>
          <p className="text-sm text-muted">
            The underwriting model is running. Results will appear here once complete.
          </p>
        </div>
      )}

      {deal.status === "complete" && (
        <CompleteSection
          deal={deal}
          latestVersion={latestVersion}
          projectId={projectId}
          propertyId={propertyId}
          onReturnToReview={() => handleNavigateBack("review")}
        />
      )}
    </Shell>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Uploading Section
 * ──────────────────────────────────────────────────────────────────────────── */

function UploadingSection({
  documents,
  docType,
  onDocTypeChange,
  onUpload,
  onDelete,
  onRunExtraction,
}: {
  documents: UwDocument[];
  docType: DocumentType;
  onDocTypeChange: (t: DocumentType) => void;
  onUpload: (files: File[]) => Promise<void>;
  onDelete: (doc: UwDocument) => void;
  onRunExtraction: () => void;
}) {
  return (
    <div className="space-y-6">
      {/* Document type selector */}
      <div className="bg-card border border-border rounded-lg p-6">
        <h3 className="text-base font-semibold mb-4">Upload Documents</h3>
        <div className="mb-4">
          <label className="block text-sm font-medium mb-1.5">
            Document Type
          </label>
          <select
            value={docType}
            onChange={(e) => onDocTypeChange(e.target.value as DocumentType)}
            className="w-full max-w-xs border border-border rounded-md px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
          >
            {DOCUMENT_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
        <UploadZone onUpload={onUpload} />
      </div>

      {/* Uploaded documents */}
      {documents.length > 0 && (
        <div className="bg-card border border-border rounded-lg">
          <div className="px-5 py-3 border-b border-border">
            <h3 className="text-sm font-semibold">
              Uploaded Documents ({documents.length})
            </h3>
          </div>
          <div className="divide-y divide-border">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between px-5 py-3"
              >
                <div className="flex items-center gap-3">
                  <FileText className="w-4 h-4 text-muted" />
                  <div>
                    <p className="text-sm font-medium">
                      {doc.original_filename}
                    </p>
                    <p className="text-xs text-muted">
                      {DOCUMENT_TYPE_OPTIONS.find(
                        (o) => o.value === doc.document_type
                      )?.label ?? doc.document_type}{" "}
                      &middot; {formatBytes(doc.file_size_bytes)}
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => onDelete(doc)}
                  className="p-1.5 rounded-md text-muted hover:text-red-600 hover:bg-red-50 transition-colors"
                  title="Delete document"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Run extraction */}
      {documents.length > 0 && (
        <div className="flex justify-end">
          <button
            onClick={onRunExtraction}
            className="flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-medium text-white bg-accent hover:bg-accent/90 transition-colors"
          >
            <TrendingUp className="w-4 h-4" />
            Run Extraction
          </button>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Review Section — Editable
 * ──────────────────────────────────────────────────────────────────────────── */

function ReviewSection({
  dealSchema,
  dealId,
  onClear,
  onSchemaUpdated,
}: {
  dealSchema: DealSchema | null;
  dealId: string;
  onClear: () => void;
  onSchemaUpdated: (schema: DealSchema) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [schema, setSchema] = useState<DealSchema | null>(dealSchema);
  const [saving, setSaving] = useState(false);

  // Keep in sync if parent deal reloads
  useEffect(() => {
    setSchema(dealSchema);
  }, [dealSchema]);

  if (!schema) {
    return (
      <div className="bg-card border border-border rounded-lg p-12 text-center">
        <AlertCircle className="w-8 h-8 text-muted mx-auto mb-4" />
        <h3 className="text-lg font-semibold mb-1">No Extracted Data</h3>
        <p className="text-sm text-muted">
          Extraction did not produce a deal schema.
        </p>
      </div>
    );
  }

  const { property, tenant, lease, financials_as_stated } = schema;

  // Deep-set a nested path: e.g. ("property", "address", "123 Main St")
  const updateField = (
    section: "property" | "tenant" | "lease" | "financials_as_stated",
    field: string,
    value: string | number | boolean | null
  ) => {
    setSchema((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        [section]: {
          ...prev[section],
          [field]: value,
        },
      };
    });
  };

  const handleSave = async () => {
    if (!schema) return;
    setSaving(true);
    const { error } = await supabase
      .from("uw_deals")
      .update({ deal_schema: schema })
      .eq("id", dealId);

    if (error) {
      toast.error("Failed to save changes");
      console.error(error);
    } else {
      toast.success("Changes saved");
      onSchemaUpdated(schema);
      setEditing(false);
    }
    setSaving(false);
  };

  const handleDiscard = () => {
    setSchema(dealSchema); // revert to original
    setEditing(false);
  };

  return (
    <div className="space-y-6">
      {/* Edit / Save toolbar */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted">
          {editing
            ? "Edit the extracted values below, then save or clear for underwriting."
            : "Review extracted data. Click Edit to modify values before underwriting."}
        </p>
        <div className="flex items-center gap-2">
          {!editing ? (
            <button
              onClick={() => setEditing(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border border-border hover:bg-gray-50 transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" />
              Edit
            </button>
          ) : (
            <>
              <button
                onClick={handleDiscard}
                className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border border-border hover:bg-gray-50 transition-colors text-muted"
              >
                Discard
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white bg-accent hover:bg-accent/90 transition-colors disabled:opacity-50"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                Save Changes
              </button>
            </>
          )}
        </div>
      </div>

      {/* Property */}
      <div className="bg-card border border-border rounded-lg">
        <div className="px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">Extracted Property Data</h3>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 p-5 text-sm">
          <EditableField label="Address" value={property.address} editing={editing} onChange={(v) => updateField("property", "address", v)} />
          <EditableField label="City" value={property.city} editing={editing} onChange={(v) => updateField("property", "city", v)} />
          <EditableField label="State" value={property.state} editing={editing} onChange={(v) => updateField("property", "state", v)} />
          <EditableField label="Market" value={property.market} editing={editing} onChange={(v) => updateField("property", "market", v)} />
          <EditableField label="Submarket" value={property.submarket} editing={editing} onChange={(v) => updateField("property", "submarket", v)} />
          <EditableField label="Year Built" value={property.year_built?.toString()} editing={editing} type="number" onChange={(v) => updateField("property", "year_built", v ? Number(v) : null)} />
          <EditableField label="GLA (SF)" value={property.gla_sf?.toString()} editing={editing} type="number" onChange={(v) => updateField("property", "gla_sf", v ? Number(v) : null)} />
          <EditableField label="Lot Size (acres)" value={property.lot_acres?.toString()} editing={editing} type="number" onChange={(v) => updateField("property", "lot_acres", v ? Number(v) : null)} />
          <EditableField label="Property Type" value={property.property_type} editing={editing} onChange={(v) => updateField("property", "property_type", v)} />
        </div>
      </div>

      {/* Tenant */}
      <div className="bg-card border border-border rounded-lg">
        <div className="px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">Tenant Information</h3>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 p-5 text-sm">
          <EditableField label="Tenant" value={tenant.name} editing={editing} onChange={(v) => updateField("tenant", "name", v)} />
          <EditableField label="Parent Company" value={tenant.parent_company} editing={editing} onChange={(v) => updateField("tenant", "parent_company", v)} />
          <EditableField label="Concept Type" value={tenant.concept_type} editing={editing} onChange={(v) => updateField("tenant", "concept_type", v)} />
          <EditableField label="Credit (Moody's)" value={tenant.credit_rating_moodys} editing={editing} onChange={(v) => updateField("tenant", "credit_rating_moodys", v)} />
          <EditableField label="Credit (S&P)" value={tenant.credit_rating_sp} editing={editing} onChange={(v) => updateField("tenant", "credit_rating_sp", v)} />
          <EditableField label="Franchisee/Operator" value={tenant.franchisee_operator} editing={editing} onChange={(v) => updateField("tenant", "franchisee_operator", v)} />
        </div>
      </div>

      {/* Lease */}
      <div className="bg-card border border-border rounded-lg">
        <div className="px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">Lease Details</h3>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 p-5 text-sm">
          <EditableField label="Lease Type" value={lease.type} editing={editing} onChange={(v) => updateField("lease", "type", v)} />
          <EditableField label="Commencement Date" value={lease.commencement_date} editing={editing} type="date" onChange={(v) => updateField("lease", "commencement_date", v)} />
          <EditableField label="Expiration Date" value={lease.expiration_date} editing={editing} type="date" onChange={(v) => updateField("lease", "expiration_date", v)} />
          <EditableField label="Remaining Term (years)" value={lease.remaining_term_years?.toString()} editing={editing} type="number" onChange={(v) => updateField("lease", "remaining_term_years", v ? Number(v) : null)} />
          <EditableField label="Base Rent (Annual)" value={lease.base_rent_annual?.toString()} editing={editing} type="number" onChange={(v) => updateField("lease", "base_rent_annual", v ? Number(v) : null)} />
          <EditableField label="Rent/SF" value={lease.rent_per_sf?.toString()} editing={editing} type="number" onChange={(v) => updateField("lease", "rent_per_sf", v ? Number(v) : null)} />
          <EditableField
            label="Options"
            value={
              lease.options?.length > 0
                ? lease.options.map((o: { term_years: number }) => `${o.term_years}yr`).join(", ")
                : "None"
            }
            editing={false}
            onChange={() => {}}
          />
        </div>
      </div>

      {/* Financials */}
      <div className="bg-card border border-border rounded-lg">
        <div className="px-5 py-3 border-b border-border">
          <h3 className="text-sm font-semibold">Financials as Stated</h3>
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 p-5 text-sm">
          <EditableField label="Asking Price" value={financials_as_stated.asking_price?.toString()} editing={editing} type="number" onChange={(v) => updateField("financials_as_stated", "asking_price", v ? Number(v) : null)} />
          <EditableField label="Asking Cap Rate" value={financials_as_stated.asking_cap_rate != null ? (financials_as_stated.asking_cap_rate * 100).toFixed(1) : ""} editing={editing} type="number" suffix="%" onChange={(v) => updateField("financials_as_stated", "asking_cap_rate", v ? Number(v) / 100 : null)} />
          <EditableField label="NOI (Year 1)" value={financials_as_stated.noi_year1?.toString()} editing={editing} type="number" onChange={(v) => updateField("financials_as_stated", "noi_year1", v ? Number(v) : null)} />
          <EditableField label="NOI Source" value={financials_as_stated.noi_source} editing={editing} onChange={(v) => updateField("financials_as_stated", "noi_source", v)} />
        </div>
      </div>

      {/* Flagged fields */}
      {schema.extraction_metadata?.flagged_fields?.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-5">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-amber-600" />
            <h3 className="text-sm font-semibold text-amber-800">
              Flagged Fields
            </h3>
          </div>
          <ul className="list-disc list-inside text-sm text-amber-700 space-y-1">
            {schema.extraction_metadata.flagged_fields.map((field: string) => (
              <li key={field}>{field}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Underwriting Assumptions */}
      <AssumptionsEditor dealId={dealId} dealSchema={schema} />

      <div className="flex justify-end">
        <button
          onClick={onClear}
          className="flex items-center gap-2 px-5 py-2.5 rounded-md text-sm font-medium text-white bg-accent hover:bg-accent/90 transition-colors"
        >
          <ShieldCheck className="w-4 h-4" />
          Clear for Underwriting
        </button>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Assumptions Editor
 * ──────────────────────────────────────────────────────────────────────────── */

function AssumptionsEditor({
  dealId,
  dealSchema,
}: {
  dealId: string;
  dealSchema: DealSchema;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load existing overrides or build defaults
  // All percentage values stored as display values (e.g. 6.5 not 0.065)
  const [overrides, setOverrides] = useState(() => {
    const financials = dealSchema.financials_as_stated;
    const askingCap = financials?.asking_cap_rate ?? 0.065;
    const exitCapPct = +((askingCap + 0.005) * 100).toFixed(1);
    return {
      hold_period_years: 5,
      exit_cap_rate_spread_bps: 50,
      exit_cap_rate_final: exitCapPct,
      cost_of_sale_pct: 1.5,
      vacancy_rate: 0,
      mgmt_fee_pct: 0,
      capex_per_sf: 0,
      // Re-leasing
      downtime_months: 6,
      market_rent_psf: 0,
      renewal_probability: 70,
      ti_psf: 0,
      lc_pct: 4,
      // Debt
      debt_enabled: false,
      debt_ltv_pct: 65,
      debt_interest_rate: 5.5,
      debt_amortization_years: 30,
      debt_loan_term_years: 10,
      debt_io_period_years: 0,
      debt_dscr_constraint: 1.25,
      debt_dscr_covenant: 1.25,
      // Market Rent Growth
      market_rent_growth_pct: 3.0,
      // Scheduled CapEx
      scheduled_capex: [] as {description: string; year: number; cost: number}[],
    };
  });

  // Load from DB if overrides exist
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("uw_deals")
        .select("assumption_overrides")
        .eq("id", dealId)
        .single();
      if (data?.assumption_overrides) {
        const o = data.assumption_overrides;
        const r = o.releasing ?? {};
        const debt = o.debt ?? {};
        const capex = o.scheduled_capex ?? [];
        setOverrides({
          hold_period_years: o.hold_period_years ?? 5,
          exit_cap_rate_spread_bps: o.exit_cap_rate_spread_bps ?? 50,
          exit_cap_rate_final: +((o.exit_cap_rate_final ?? 0.07) * 100).toFixed(1),
          cost_of_sale_pct: +((o.cost_of_sale_pct ?? 0.015) * 100).toFixed(1),
          vacancy_rate: +((o.vacancy_rate_during_term ?? o.vacancy_rate ?? 0) * 100).toFixed(1),
          mgmt_fee_pct: +((o.mgmt_fee_pct ?? 0) * 100).toFixed(1),
          capex_per_sf: o.capex_per_sf ?? 0,
          downtime_months: r.downtime_months ?? 6,
          market_rent_psf: r.market_rent_psf ?? 0,
          renewal_probability: +((r.renewal_probability ?? 0.7) * 100).toFixed(0),
          ti_psf: r.ti_psf ?? 0,
          lc_pct: +((r.lc_pct ?? 0.04) * 100).toFixed(1),
          debt_enabled: debt.loan_enabled ?? false,
          debt_ltv_pct: +((debt.ltv_pct ?? 0.65) * 100).toFixed(1),
          debt_interest_rate: +((debt.interest_rate ?? 0.055) * 100).toFixed(1),
          debt_amortization_years: debt.amortization_years ?? 30,
          debt_loan_term_years: debt.loan_term_years ?? 10,
          debt_io_period_years: debt.io_period_years ?? 0,
          debt_dscr_constraint: debt.dscr_constraint ?? 1.25,
          debt_dscr_covenant: debt.dscr_covenant ?? 1.25,
          market_rent_growth_pct: +((o.market_rent_growth_pct ?? 0.03) * 100).toFixed(1),
          scheduled_capex: capex,
        });
      }
    })();
  }, [dealId]);

  const handleSave = async () => {
    setSaving(true);
    const payload = {
      hold_period_years: overrides.hold_period_years,
      exit_cap_rate_spread_bps: overrides.exit_cap_rate_spread_bps,
      exit_cap_rate_final: overrides.exit_cap_rate_final / 100,
      cost_of_sale_pct: overrides.cost_of_sale_pct / 100,
      vacancy_rate_during_term: overrides.vacancy_rate / 100,
      vacancy_rate_after_term: 0.05,
      mgmt_fee_pct: overrides.mgmt_fee_pct / 100,
      capex_per_sf: overrides.capex_per_sf,
      releasing: {
        downtime_months: overrides.downtime_months,
        market_rent_psf: overrides.market_rent_psf,
        renewal_probability: overrides.renewal_probability / 100,
        renewal_rent_bump_pct: 0,
        new_lease_term_years: 5,
        new_lease_bump_pct: 0.02,
        ti_psf: overrides.ti_psf,
        lc_pct: overrides.lc_pct / 100,
      },
      debt: {
        loan_enabled: overrides.debt_enabled,
        ltv_pct: overrides.debt_ltv_pct / 100,
        interest_rate: overrides.debt_interest_rate / 100,
        amortization_years: overrides.debt_amortization_years,
        loan_term_years: overrides.debt_loan_term_years,
        io_period_years: overrides.debt_io_period_years,
        dscr_constraint: overrides.debt_dscr_constraint,
        dscr_covenant: overrides.debt_dscr_covenant,
      },
      market_rent_growth_pct: overrides.market_rent_growth_pct / 100,
      scheduled_capex: overrides.scheduled_capex,
    };
    const { error } = await supabase
      .from("uw_deals")
      .update({ assumption_overrides: payload })
      .eq("id", dealId);
    if (error) {
      toast.error("Failed to save assumptions");
    } else {
      toast.success("Assumptions saved — will apply on next underwriting run");
    }
    setSaving(false);
  };

  return (
    <div className="bg-card border border-border rounded-lg">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-5 py-3 text-sm font-semibold hover:bg-gray-50 transition-colors rounded-lg"
      >
        <div className="flex items-center gap-2">
          <SlidersHorizontal className="w-4 h-4 text-accent" />
          Underwriting Assumptions
        </div>
        <ChevronDown
          className={cn(
            "w-4 h-4 text-muted transition-transform",
            open && "rotate-180"
          )}
        />
      </button>

      {open && (
        <div className="border-t border-border px-5 py-4 space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs text-muted mb-1">Hold Period (years)</label>
              <input
                type="number"
                min={1}
                max={20}
                value={overrides.hold_period_years}
                onChange={(e) => setOverrides((p) => ({ ...p, hold_period_years: parseInt(e.target.value) || 5 }))}
                className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Exit Cap Rate (%)</label>
              <input
                type="number"
                step="0.1"
                value={overrides.exit_cap_rate_final}
                onChange={(e) => setOverrides((p) => ({ ...p, exit_cap_rate_final: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Cost of Sale (%)</label>
              <input
                type="number"
                step="0.1"
                value={overrides.cost_of_sale_pct}
                onChange={(e) => setOverrides((p) => ({ ...p, cost_of_sale_pct: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Vacancy (%)</label>
              <input
                type="number"
                step="0.1"
                value={overrides.vacancy_rate}
                onChange={(e) => setOverrides((p) => ({ ...p, vacancy_rate: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">Mgmt Fee (%)</label>
              <input
                type="number"
                step="0.1"
                value={overrides.mgmt_fee_pct}
                onChange={(e) => setOverrides((p) => ({ ...p, mgmt_fee_pct: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </div>
            <div>
              <label className="block text-xs text-muted mb-1">CapEx ($/SF)</label>
              <input
                type="number"
                step="0.05"
                value={overrides.capex_per_sf}
                onChange={(e) => setOverrides((p) => ({ ...p, capex_per_sf: parseFloat(e.target.value) || 0 }))}
                className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
              />
            </div>
          </div>

          {/* Re-Leasing Assumptions */}
          <div className="border-t border-border pt-4 mt-2">
            <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">Re-Leasing (Post-Expiry)</h4>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <div>
                <label className="block text-xs text-muted mb-1">Downtime (months)</label>
                <input
                  type="number"
                  step="1"
                  min={0}
                  max={24}
                  value={overrides.downtime_months}
                  onChange={(e) => setOverrides((p) => ({ ...p, downtime_months: parseInt(e.target.value) || 0 }))}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">Market Rent ($/SF)</label>
                <input
                  type="number"
                  step="0.5"
                  min={0}
                  value={overrides.market_rent_psf}
                  onChange={(e) => setOverrides((p) => ({ ...p, market_rent_psf: parseFloat(e.target.value) || 0 }))}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">Renewal Prob (%)</label>
                <input
                  type="number"
                  step="5"
                  min={0}
                  max={100}
                  value={overrides.renewal_probability}
                  onChange={(e) => setOverrides((p) => ({ ...p, renewal_probability: parseInt(e.target.value) || 0 }))}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">TI ($/SF)</label>
                <input
                  type="number"
                  step="0.5"
                  min={0}
                  value={overrides.ti_psf}
                  onChange={(e) => setOverrides((p) => ({ ...p, ti_psf: parseFloat(e.target.value) || 0 }))}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
              <div>
                <label className="block text-xs text-muted mb-1">LC (%)</label>
                <input
                  type="number"
                  step="0.1"
                  min={0}
                  max={10}
                  value={overrides.lc_pct}
                  onChange={(e) => setOverrides((p) => ({ ...p, lc_pct: parseFloat(e.target.value) || 0 }))}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30"
                />
              </div>
            </div>
          </div>

          {/* Debt Assumptions */}
          <div className="border-t border-border pt-4 mt-2">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-semibold text-muted uppercase tracking-wider">Debt Modeling</h4>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={overrides.debt_enabled}
                  onChange={(e) => setOverrides((p) => ({ ...p, debt_enabled: e.target.checked }))}
                  className="rounded border-border"
                />
                Enable
              </label>
            </div>
            {overrides.debt_enabled && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs text-muted mb-1">LTV (%)</label>
                  <input type="number" step="0.1" min={0} max={100} value={overrides.debt_ltv_pct}
                    onChange={(e) => setOverrides((p) => ({ ...p, debt_ltv_pct: parseFloat(e.target.value) || 0 }))}
                    className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30" />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">Interest Rate (%)</label>
                  <input type="number" step="0.1" min={0} max={20} value={overrides.debt_interest_rate}
                    onChange={(e) => setOverrides((p) => ({ ...p, debt_interest_rate: parseFloat(e.target.value) || 0 }))}
                    className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30" />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">Amortization (yrs)</label>
                  <input type="number" step="1" min={5} max={40} value={overrides.debt_amortization_years}
                    onChange={(e) => setOverrides((p) => ({ ...p, debt_amortization_years: parseInt(e.target.value) || 30 }))}
                    className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30" />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">Loan Term (yrs)</label>
                  <input type="number" step="1" min={1} max={30} value={overrides.debt_loan_term_years}
                    onChange={(e) => setOverrides((p) => ({ ...p, debt_loan_term_years: parseInt(e.target.value) || 10 }))}
                    className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30" />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">IO Period (yrs)</label>
                  <input type="number" step="1" min={0} max={10} value={overrides.debt_io_period_years}
                    onChange={(e) => setOverrides((p) => ({ ...p, debt_io_period_years: parseInt(e.target.value) || 0 }))}
                    className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30" />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">DSCR Constraint</label>
                  <input type="number" step="0.05" min={1} max={3} value={overrides.debt_dscr_constraint}
                    onChange={(e) => setOverrides((p) => ({ ...p, debt_dscr_constraint: parseFloat(e.target.value) || 1.25 }))}
                    className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30" />
                </div>
                <div>
                  <label className="block text-xs text-muted mb-1">DSCR Covenant</label>
                  <input type="number" step="0.05" min={1} max={3} value={overrides.debt_dscr_covenant}
                    onChange={(e) => setOverrides((p) => ({ ...p, debt_dscr_covenant: parseFloat(e.target.value) || 1.25 }))}
                    className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30" />
                </div>
              </div>
            )}
          </div>

          {/* Market Rent Growth */}
          <div className="border-t border-border pt-4 mt-2">
            <h4 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3">Market Rent Growth</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div>
                <label className="block text-xs text-muted mb-1">Annual Growth (%)</label>
                <input type="number" step="0.1" min={0} max={10} value={overrides.market_rent_growth_pct}
                  onChange={(e) => setOverrides((p) => ({ ...p, market_rent_growth_pct: parseFloat(e.target.value) || 0 }))}
                  className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30" />
              </div>
            </div>
          </div>

          {/* Scheduled CapEx */}
          <div className="border-t border-border pt-4 mt-2">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-xs font-semibold text-muted uppercase tracking-wider">Scheduled CapEx</h4>
              <button
                onClick={() => setOverrides((p) => ({
                  ...p,
                  scheduled_capex: [...p.scheduled_capex, { description: "", year: 1, cost: 0 }],
                }))}
                className="text-xs text-accent hover:underline"
              >
                + Add Item
              </button>
            </div>
            {overrides.scheduled_capex.length > 0 && (
              <div className="space-y-2">
                {overrides.scheduled_capex.map((item, idx) => (
                  <div key={idx} className="grid grid-cols-[1fr_80px_120px_32px] gap-2 items-end">
                    <div>
                      <label className="block text-xs text-muted mb-1">Description</label>
                      <input type="text" value={item.description}
                        onChange={(e) => {
                          const updated = [...overrides.scheduled_capex];
                          updated[idx] = { ...updated[idx], description: e.target.value };
                          setOverrides((p) => ({ ...p, scheduled_capex: updated }));
                        }}
                        className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30" />
                    </div>
                    <div>
                      <label className="block text-xs text-muted mb-1">Year</label>
                      <input type="number" min={1} max={30} value={item.year}
                        onChange={(e) => {
                          const updated = [...overrides.scheduled_capex];
                          updated[idx] = { ...updated[idx], year: parseInt(e.target.value) || 1 };
                          setOverrides((p) => ({ ...p, scheduled_capex: updated }));
                        }}
                        className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30" />
                    </div>
                    <div>
                      <label className="block text-xs text-muted mb-1">Cost ($)</label>
                      <input type="number" min={0} step="1000" value={item.cost}
                        onChange={(e) => {
                          const updated = [...overrides.scheduled_capex];
                          updated[idx] = { ...updated[idx], cost: parseFloat(e.target.value) || 0 };
                          setOverrides((p) => ({ ...p, scheduled_capex: updated }));
                        }}
                        className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30" />
                    </div>
                    <button
                      onClick={() => {
                        const updated = overrides.scheduled_capex.filter((_, i) => i !== idx);
                        setOverrides((p) => ({ ...p, scheduled_capex: updated }));
                      }}
                      className="p-1.5 text-muted hover:text-red-600 rounded-md hover:bg-red-50 transition-colors mb-0.5"
                      title="Remove"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  </div>
                ))}
              </div>
            )}
            {overrides.scheduled_capex.length === 0 && (
              <p className="text-xs text-muted">No scheduled capital expenditures. Click &quot;+ Add Item&quot; to add.</p>
            )}
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium text-white bg-accent hover:bg-accent/90 transition-colors disabled:opacity-50"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Save Assumptions
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Editable Field
 * ──────────────────────────────────────────────────────────────────────────── */

function EditableField({
  label,
  value,
  editing,
  onChange,
  type = "text",
  suffix,
}: {
  label: string;
  value: string | null | undefined;
  editing: boolean;
  onChange: (value: string) => void;
  type?: "text" | "number" | "date";
  suffix?: string;
}) {
  if (!editing) {
    let displayValue = value;
    if (type === "number" && value && !suffix) {
      const num = Number(value);
      if (!isNaN(num) && num > 1000) {
        displayValue = num.toLocaleString();
      }
    }
    if (suffix && value) {
      displayValue = `${value}${suffix}`;
    }
    return (
      <div>
        <dt className="text-xs text-muted mb-0.5">{label}</dt>
        <dd className="font-medium">{displayValue || <span className="text-muted">--</span>}</dd>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-xs text-muted mb-1">{label}</label>
      <div className="relative">
        <input
          type={type === "date" ? "date" : type === "number" ? "number" : "text"}
          step={type === "number" ? "any" : undefined}
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          className="w-full px-3 py-1.5 text-sm border border-border rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
        />
        {suffix && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Complete Section
 * ──────────────────────────────────────────────────────────────────────────── */

function CompleteSection({
  deal,
  latestVersion,
  projectId,
  propertyId,
  onReturnToReview,
}: {
  deal: UwDeal;
  latestVersion: UwVersion | null;
  projectId: string;
  propertyId: string;
  onReturnToReview: () => void;
}) {
  const output = deal.underwriting_output;
  const schema = deal.deal_schema;
  const recVariant =
    deal.recommendation === "go"
      ? "go"
      : deal.recommendation === "watch"
      ? "watch"
      : deal.recommendation === "pass"
      ? "pass"
      : "default";

  const riskFlags = latestVersion?.risk_flags ?? [];

  return (
    <div className="space-y-6">
      {/* Summary header */}
      <div className="bg-card border border-border rounded-lg p-6">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h3 className="text-lg font-semibold mb-2">
              Underwriting Results
            </h3>
            <p className="text-sm text-muted">
              {deal.recommendation_rationale || "Underwriting complete."}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <Badge
              variant={recVariant as "go" | "watch" | "pass" | "default"}
              className="text-base px-4 py-1.5"
            >
              {deal.recommendation
                ? deal.recommendation.charAt(0).toUpperCase() +
                  deal.recommendation.slice(1)
                : "N/A"}
            </Badge>
          </div>
        </div>

        {/* Risk score */}
        <div className="flex items-center gap-6 mb-6">
          <div>
            <p className="text-xs text-muted mb-1">Risk Score</p>
            <p
              className={cn(
                "text-3xl font-bold tabular-nums",
                riskScoreColor(deal.risk_score)
              )}
            >
              {deal.risk_score ?? "--"}
            </p>
            <p className="text-xs text-muted">
              {riskTier(deal.risk_score)}
            </p>
          </div>
        </div>

        {/* Key metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4 pt-4 border-t border-border">
          <MetricCard
            label="Asking Price"
            value={formatCurrency(
              schema?.financials_as_stated.asking_price
            )}
          />
          <MetricCard
            label="Cap Rate"
            value={formatPercent(
              schema?.financials_as_stated.asking_cap_rate, 1
            )}
          />
          <MetricCard
            label="NOI"
            value={formatCurrency(
              schema?.financials_as_stated.noi_year1
            )}
          />
          <MetricCard
            label="Target Price"
            value={formatCurrency(output?.pricing_output.target_price)}
          />
          <MetricCard
            label="Walk-Away Price"
            value={formatCurrency(output?.pricing_output.walk_away_price)}
          />
        </div>
      </div>

      {/* Risk flags */}
      {riskFlags.length > 0 && (
        <div className="bg-card border border-border rounded-lg">
          <div className="px-5 py-3 border-b border-border">
            <h3 className="text-sm font-semibold">Risk Flags</h3>
          </div>
          <div className="divide-y divide-border">
            {riskFlags.map((flag, i) => (
              <div key={i} className="px-5 py-3">
                <div className="flex items-center gap-2 mb-1">
                  <AlertTriangle
                    className={cn(
                      "w-4 h-4",
                      flag.severity === "High"
                        ? "text-red-500"
                        : flag.severity === "Moderate"
                        ? "text-yellow-500"
                        : "text-blue-500"
                    )}
                  />
                  <span className="text-sm font-medium">{flag.flag}</span>
                  <Badge
                    variant={
                      flag.severity === "High"
                        ? "pass"
                        : flag.severity === "Moderate"
                        ? "watch"
                        : "default"
                    }
                  >
                    {flag.severity}
                  </Badge>
                </div>
                <p className="text-xs text-muted ml-6">{flag.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="bg-card border border-border rounded-lg p-5">
        <h3 className="text-sm font-semibold mb-4">Outputs & Actions</h3>
        <div className="flex flex-wrap gap-3">
          <Link
            href={`/projects/${projectId}/properties/${propertyId}/deals/${deal.id}/proforma`}
            className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border border-border hover:bg-gray-50 transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            View Pro Forma
          </Link>
          <button
            onClick={onReturnToReview}
            className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border border-accent text-accent hover:bg-accent/5 transition-colors"
          >
            <Pencil className="w-4 h-4" />
            Edit & Rerun
          </button>
          {deal.memo_pdf_key && (
            <a
              href={
                supabase.storage
                  .from("uw-source-documents")
                  .getPublicUrl(deal.memo_pdf_key).data.publicUrl
              }
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border border-border hover:bg-gray-50 transition-colors"
            >
              <Download className="w-4 h-4" />
              Download Memo PDF
            </a>
          )}
          {!deal.memo_pdf_key && (
            <button
              disabled
              className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border border-border text-muted opacity-50 cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
              Memo PDF (Not Available)
            </button>
          )}
          {deal.proforma_excel_key && (
            <a
              href={
                supabase.storage
                  .from("uw-source-documents")
                  .getPublicUrl(deal.proforma_excel_key).data.publicUrl
              }
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border border-border hover:bg-gray-50 transition-colors"
            >
              <Download className="w-4 h-4" />
              Download Excel
            </a>
          )}
          {!deal.proforma_excel_key && (
            <button
              disabled
              className="flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium border border-border text-muted opacity-50 cursor-not-allowed"
            >
              <Download className="w-4 h-4" />
              Excel (Not Available)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <p className="text-xs text-muted mb-0.5">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}
