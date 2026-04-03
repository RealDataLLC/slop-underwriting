"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Plus, FolderKanban } from "lucide-react";
import { toast } from "sonner";
import { Shell } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { supabase } from "@/lib/supabase";
import { cn, formatPercent, formatRelativeDate } from "@/lib/utils";
import type { UwProject, ProjectStatus, PropertyType } from "@/lib/types";

type ProjectWithCount = UwProject & { property_count: number };

const statusVariant: Record<ProjectStatus, "status" | "go" | "watch" | "pass" | "default"> = {
  active: "go",
  under_contract: "watch",
  closed: "status",
  dead: "pass",
};

const statusLabel: Record<ProjectStatus, string> = {
  active: "Active",
  under_contract: "Under Contract",
  closed: "Closed",
  dead: "Dead",
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<ProjectWithCount[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formTargetCapRate, setFormTargetCapRate] = useState("");
  const [formMaxCapRate, setFormMaxCapRate] = useState("");
  const [formTargetIrr, setFormTargetIrr] = useState("");

  const fetchProjects = useCallback(async () => {
    setLoading(true);
    const { data: projectData, error } = await supabase
      .from("uw_projects")
      .select("*")
      .order("updated_at", { ascending: false });

    if (error) {
      toast.error("Failed to load projects");
      setLoading(false);
      return;
    }

    if (!projectData || projectData.length === 0) {
      setProjects([]);
      setLoading(false);
      return;
    }

    // Fetch property counts per project
    const { data: countData } = await supabase
      .from("uw_properties")
      .select("project_id");

    const countMap: Record<string, number> = {};
    if (countData) {
      for (const row of countData) {
        countMap[row.project_id] = (countMap[row.project_id] || 0) + 1;
      }
    }

    const withCounts: ProjectWithCount[] = projectData.map((p) => ({
      ...p,
      property_count: countMap[p.id] || 0,
    }));

    setProjects(withCounts);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const resetForm = () => {
    setFormName("");
    setFormDescription("");
    setFormTargetCapRate("");
    setFormMaxCapRate("");
    setFormTargetIrr("");
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formName.trim()) {
      toast.error("Project name is required");
      return;
    }

    setCreating(true);

    const parseRate = (v: string): number | null => {
      if (!v.trim()) return null;
      const n = parseFloat(v);
      return isNaN(n) ? null : n / 100;
    };

    const { error } = await supabase.from("uw_projects").insert({
      name: formName.trim(),
      description: formDescription.trim() || null,
      status: "active" as const,
      target_cap_rate: parseRate(formTargetCapRate),
      max_cap_rate: parseRate(formMaxCapRate),
      target_irr: parseRate(formTargetIrr),
      created_by: null,
      notes: null,
    });

    setCreating(false);

    if (error) {
      toast.error("Failed to create project");
      return;
    }

    toast.success("Project created");
    setModalOpen(false);
    resetForm();
    fetchProjects();
  };

  return (
    <Shell>
      <div className="flex items-center justify-between mb-8">
        <h1 className="text-2xl font-semibold text-foreground">Projects</h1>
        <button
          onClick={() => setModalOpen(true)}
          className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
        >
          <Plus className="w-4 h-4" />
          New Project
        </button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-card border border-border rounded-xl p-6 animate-pulse">
              <div className="h-5 bg-gray-200 rounded w-2/3 mb-3" />
              <div className="h-4 bg-gray-100 rounded w-1/3 mb-4" />
              <div className="h-4 bg-gray-100 rounded w-full mb-2" />
              <div className="h-4 bg-gray-100 rounded w-3/4" />
            </div>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create your first underwriting project to start analyzing properties."
          action={
            <button
              onClick={() => setModalOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 transition-colors"
            >
              <Plus className="w-4 h-4" />
              New Project
            </button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <Link
              key={project.id}
              href={`/projects/${project.id}`}
              className="block bg-card border border-border rounded-xl p-6 hover:border-accent/40 hover:shadow-sm transition-all group"
            >
              <div className="flex items-start justify-between mb-3">
                <h3 className="font-semibold text-foreground group-hover:text-accent transition-colors truncate pr-2">
                  {project.name}
                </h3>
                <Badge variant={statusVariant[project.status]}>
                  {statusLabel[project.status]}
                </Badge>
              </div>

              {project.description && (
                <p className="text-sm text-muted mb-4 line-clamp-2">
                  {project.description}
                </p>
              )}

              <div className="flex items-center gap-4 text-xs text-muted mt-auto">
                <span>
                  {project.property_count}{" "}
                  {project.property_count === 1 ? "property" : "properties"}
                </span>
                {project.target_cap_rate != null && (
                  <span>Target: {formatPercent(project.target_cap_rate)}</span>
                )}
              </div>

              <div className="text-xs text-muted mt-3 pt-3 border-t border-border">
                Updated {formatRelativeDate(project.updated_at)}
              </div>
            </Link>
          ))}
        </div>
      )}

      <Modal
        open={modalOpen}
        onClose={() => {
          setModalOpen(false);
          resetForm();
        }}
        title="New Project"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Project Name <span className="text-pass">*</span>
            </label>
            <input
              type="text"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="e.g. Q2 2026 NNN Acquisitions"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-foreground mb-1">
              Description
            </label>
            <textarea
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              rows={3}
              placeholder="Brief description of the project scope..."
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent resize-none"
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Target Cap Rate
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="0.01"
                  value={formTargetCapRate}
                  onChange={(e) => setFormTargetCapRate(e.target.value)}
                  placeholder="6.50"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-7 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">%</span>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Max Cap Rate
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="0.01"
                  value={formMaxCapRate}
                  onChange={(e) => setFormMaxCapRate(e.target.value)}
                  placeholder="7.00"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-7 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">%</span>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">
                Target IRR
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="0.01"
                  value={formTargetIrr}
                  onChange={(e) => setFormTargetIrr(e.target.value)}
                  placeholder="10.00"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-7 text-sm text-foreground placeholder:text-muted/60 focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">%</span>
              </div>
            </div>
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
              {creating ? "Creating..." : "Create Project"}
            </button>
          </div>
        </form>
      </Modal>
    </Shell>
  );
}
