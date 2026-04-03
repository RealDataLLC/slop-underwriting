"use client";

import { useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  FileText,
  Building2,
  Plus,
  Check,
  Loader2,
  X,
  Sparkles,
  MapPin,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Modal } from "@/components/ui/modal";
import type { UwProperty, PropertyType } from "@/lib/types";

// Hit FastAPI directly to bypass Next.js proxy body size limits
const API_BASE = "http://127.0.0.1:8000";

type UploadStage =
  | "idle"
  | "uploading"
  | "identifying"
  | "matched"
  | "no-match"
  | "creating";

interface IdentifyResult {
  document_type: string | null;
  property_address: string | null;
  city: string | null;
  state: string | null;
  tenant_name: string | null;
  property_name: string | null;
  property_type: string | null;
  asking_price: number | null;
  confidence: number;
  matched_property: UwProperty | null;
  suggested_name: string | null;
}

interface SmartUploadProps {
  projectId: string;
  properties: UwProperty[];
  onDealCreated: (dealId: string, propertyId: string) => void;
}

const PROPERTY_TYPES: PropertyType[] = [
  "QSR", "Pharmacy", "Dollar", "Auto", "C-Store", "Bank", "Medical", "Other",
];

export function SmartUpload({ projectId, properties, onDealCreated }: SmartUploadProps) {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [stage, setStage] = useState<UploadStage>("idle");
  const [dragOver, setDragOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [identity, setIdentity] = useState<IdentifyResult | null>(null);

  // Form state for creating new property
  const [newName, setNewName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newCity, setNewCity] = useState("");
  const [newState, setNewState] = useState("");
  const [newType, setNewType] = useState<PropertyType | "">("");

  // Manual property selection
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);
  const [showPropertyPicker, setShowPropertyPicker] = useState(false);

  const resetState = useCallback(() => {
    setStage("idle");
    setFile(null);
    setStorageKey(null);
    setIdentity(null);
    setNewName("");
    setNewAddress("");
    setNewCity("");
    setNewState("");
    setNewType("");
    setSelectedPropertyId(null);
    setShowPropertyPicker(false);
  }, []);

  const handleFile = useCallback(async (f: File) => {
    setFile(f);
    setStage("uploading");

    try {
      // Step 1: Upload to storage
      const uploadForm = new FormData();
      uploadForm.append("file", f);
      uploadForm.append("project_id", projectId);

      const uploadRes = await fetch(`${API_BASE}/upload`, {
        method: "POST",
        body: uploadForm,
      });

      if (!uploadRes.ok) throw new Error("Upload failed");
      const uploadData = await uploadRes.json();
      setStorageKey(uploadData.storage_key);

      // Step 2: Identify document
      setStage("identifying");

      const idForm = new FormData();
      idForm.append("file", f);
      idForm.append("project_id", projectId);

      const idRes = await fetch(`${API_BASE}/identify`, {
        method: "POST",
        body: idForm,
      });

      if (!idRes.ok) throw new Error("Identification failed");
      const idData: IdentifyResult = await idRes.json();
      setIdentity(idData);

      if (idData.matched_property) {
        setStage("matched");
        setSelectedPropertyId(idData.matched_property.id);
      } else {
        setStage("no-match");
        // Pre-fill form from extracted data
        setNewName(idData.suggested_name || "");
        setNewAddress(idData.property_address || "");
        setNewCity(idData.city || "");
        setNewState(idData.state || "");
        setNewType((idData.property_type as PropertyType) || "");
      }
    } catch (err) {
      toast.error("Failed to process document");
      console.error(err);
      resetState();
    }
  }, [projectId, resetState]);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f && (f.type === "application/pdf" || f.name.endsWith(".xlsx") || f.name.endsWith(".xls") || f.name.endsWith(".csv"))) {
        handleFile(f);
      } else {
        toast.error("Please drop a PDF, Excel, or CSV file");
      }
    },
    [handleFile]
  );

  const handleConfirm = useCallback(async (propertyId: string | null) => {
    if (!storageKey) return;

    setStage("creating");

    try {
      const body: Record<string, unknown> = {
        project_id: projectId,
        storage_key: storageKey,
        document_type: identity?.document_type || "om",
      };

      if (propertyId) {
        body.property_id = propertyId;
      } else {
        body.property_name = newName || identity?.suggested_name || "New Property";
        body.property_address = newAddress || identity?.property_address;
        body.city = newCity || identity?.city;
        body.state = newState || identity?.state;
        body.property_type = newType || identity?.property_type;
      }

      const res = await fetch(`${API_BASE}/deals/create-from-upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Failed to create deal");
      const data = await res.json();

      toast.success("Deal created — extraction running");
      onDealCreated(data.deal_id, data.property_id);
      resetState();

      // Navigate to the deal
      router.push(
        `/projects/${projectId}/properties/${data.property_id}/deals/${data.deal_id}`
      );
    } catch (err) {
      toast.error("Failed to create deal");
      console.error(err);
      setStage("no-match");
    }
  }, [storageKey, projectId, identity, newName, newAddress, newCity, newState, newType, onDealCreated, resetState, router]);

  // ─── Render ──────────────────────────────────────────────────────────────

  if (stage === "idle") {
    return (
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          "border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-all",
          dragOver
            ? "border-accent bg-accent-light"
            : "border-border hover:border-accent/40 hover:bg-accent-light/50"
        )}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.xlsx,.xls,.csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
        <Upload className="w-8 h-8 text-accent mx-auto mb-3" />
        <p className="font-medium text-foreground mb-1">
          Drop an OM, rent roll, or financial statement
        </p>
        <p className="text-sm text-muted">
          Slop will read the document and figure out which property it belongs to
        </p>
        <p className="text-xs text-muted mt-2">PDF, Excel, or CSV</p>
      </div>
    );
  }

  if (stage === "uploading" || stage === "identifying") {
    return (
      <div className="border-2 border-accent/30 rounded-xl p-8 bg-accent-light/50">
        <div className="flex items-center justify-center gap-3">
          <Loader2 className="w-5 h-5 text-accent animate-spin" />
          <div>
            <p className="font-medium text-foreground">
              {stage === "uploading" ? "Uploading..." : "Reading document..."}
            </p>
            <p className="text-sm text-muted">
              {stage === "identifying" && (
                <span className="flex items-center gap-1">
                  <Sparkles className="w-3 h-3" />
                  AI is identifying the property from the document
                </span>
              )}
            </p>
          </div>
        </div>
        {file && (
          <div className="mt-4 flex items-center gap-2 justify-center text-sm text-muted">
            <FileText className="w-4 h-4" />
            {file.name}
          </div>
        )}
      </div>
    );
  }

  // Matched or no-match — show the confirmation UI
  return (
    <Modal
      open={stage === "matched" || stage === "no-match" || stage === "creating"}
      onClose={resetState}
      title={identity?.matched_property ? "Property Identified" : "New Property Detected"}
    >
      <div className="space-y-5">
        {/* Document info */}
        <div className="flex items-start gap-3 p-3 rounded-lg bg-accent-light/70">
          <FileText className="w-5 h-5 text-accent mt-0.5 shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground truncate">
              {file?.name}
            </p>
            <p className="text-xs text-muted">
              {identity?.document_type === "om" && "Offering Memorandum"}
              {identity?.document_type === "rent_roll" && "Rent Roll"}
              {identity?.document_type === "financial_statement" && "Financial Statement"}
              {identity?.document_type === "lease" && "Lease Document"}
              {identity?.document_type === "other" && "Document"}
              {identity?.confidence != null && (
                <span className="ml-2 text-accent">
                  {Math.round(identity.confidence * 100)}% confidence
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Extracted identity */}
        {(identity?.tenant_name || identity?.property_address) && (
          <div className="p-3 rounded-lg border border-border bg-card">
            <p className="text-xs font-medium text-muted mb-2 uppercase tracking-wider">
              Extracted from document
            </p>
            <div className="space-y-1 text-sm">
              {identity.tenant_name && (
                <p><span className="text-muted">Tenant:</span> <span className="font-medium">{identity.tenant_name}</span></p>
              )}
              {identity.property_address && (
                <p className="flex items-center gap-1">
                  <MapPin className="w-3 h-3 text-muted" />
                  {identity.property_address}
                  {identity.city && `, ${identity.city}`}
                  {identity.state && `, ${identity.state}`}
                </p>
              )}
              {identity.asking_price && (
                <p><span className="text-muted">Asking:</span> ${identity.asking_price.toLocaleString()}</p>
              )}
            </div>
          </div>
        )}

        {/* Match result */}
        {identity?.matched_property ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 p-3 rounded-lg border-2 border-go/30 bg-green-50">
              <Check className="w-5 h-5 text-go" />
              <div>
                <p className="text-sm font-medium text-foreground">
                  Matched to: {identity.matched_property.name}
                </p>
                <p className="text-xs text-muted">
                  {identity.matched_property.property_address}
                  {identity.matched_property.city && `, ${identity.matched_property.city}`}
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => handleConfirm(identity.matched_property!.id)}
                disabled={stage === "creating"}
                className={cn(
                  "flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors",
                  stage === "creating" && "opacity-50 cursor-not-allowed"
                )}
              >
                {stage === "creating" ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Creating...</>
                ) : (
                  <><Check className="w-4 h-4" /> Confirm &amp; Run Extraction</>
                )}
              </button>
              <button
                onClick={() => {
                  setShowPropertyPicker(true);
                  setStage("no-match");
                }}
                className="rounded-lg border border-border px-3 py-2.5 text-sm text-muted hover:text-foreground transition-colors"
              >
                Wrong match
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Assign to existing or create new */}
            {properties.length > 0 && !showPropertyPicker && (
              <div className="flex gap-2">
                <button
                  onClick={() => setShowPropertyPicker(false)}
                  className="flex-1 rounded-lg border-2 border-accent bg-accent-light px-3 py-2 text-sm font-medium text-accent"
                >
                  <Plus className="w-4 h-4 inline mr-1" />
                  Create New Property
                </button>
                <button
                  onClick={() => setShowPropertyPicker(true)}
                  className="flex-1 rounded-lg border border-border px-3 py-2 text-sm text-muted hover:border-accent/40 transition-colors"
                >
                  <Building2 className="w-4 h-4 inline mr-1" />
                  Assign to Existing
                </button>
              </div>
            )}

            {showPropertyPicker ? (
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground">Select property:</p>
                <div className="max-h-48 overflow-y-auto space-y-1">
                  {properties.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setSelectedPropertyId(p.id)}
                      className={cn(
                        "w-full text-left px-3 py-2 rounded-lg text-sm transition-colors",
                        selectedPropertyId === p.id
                          ? "bg-accent text-white"
                          : "hover:bg-accent-light"
                      )}
                    >
                      <p className="font-medium">{p.name}</p>
                      <p className={cn("text-xs", selectedPropertyId === p.id ? "text-white/70" : "text-muted")}>
                        {p.property_address}
                      </p>
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => selectedPropertyId && handleConfirm(selectedPropertyId)}
                  disabled={!selectedPropertyId || stage === "creating"}
                  className={cn(
                    "w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors",
                    (!selectedPropertyId || stage === "creating") && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {stage === "creating" ? (
                    <><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Creating...</>
                  ) : (
                    "Assign & Run Extraction"
                  )}
                </button>
              </div>
            ) : (
              /* New property form */
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Property Name</label>
                  <input
                    type="text"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-foreground mb-1">Address</label>
                  <input
                    type="text"
                    value={newAddress}
                    onChange={(e) => setNewAddress(e.target.value)}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">City</label>
                    <input
                      type="text"
                      value={newCity}
                      onChange={(e) => setNewCity(e.target.value)}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">State</label>
                    <input
                      type="text"
                      value={newState}
                      onChange={(e) => setNewState(e.target.value)}
                      maxLength={2}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent uppercase"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-foreground mb-1">Type</label>
                    <select
                      value={newType}
                      onChange={(e) => setNewType(e.target.value as PropertyType)}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                    >
                      <option value="">—</option>
                      {PROPERTY_TYPES.map((t) => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <button
                  onClick={() => handleConfirm(null)}
                  disabled={!newName.trim() || stage === "creating"}
                  className={cn(
                    "w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-white hover:bg-accent/90 transition-colors",
                    (!newName.trim() || stage === "creating") && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {stage === "creating" ? (
                    <><Loader2 className="w-4 h-4 animate-spin inline mr-2" /> Creating...</>
                  ) : (
                    <><Plus className="w-4 h-4 inline mr-1" /> Create Property & Run Extraction</>
                  )}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
