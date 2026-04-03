import { type Recommendation } from "./types";

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPercent(value: number | null | undefined, decimals = 2): string {
  if (value == null) return "—";
  return `${(value * 100).toFixed(decimals)}%`;
}

export function formatBps(value: number | null | undefined): string {
  if (value == null) return "—";
  return `${Math.round(value * 10000)} bps`;
}

export function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function formatRelativeDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return formatDate(dateStr);
}

export function recommendationColor(rec: Recommendation | null | undefined): string {
  switch (rec) {
    case "go": return "text-go";
    case "watch": return "text-watch";
    case "pass": return "text-pass";
    default: return "text-muted";
  }
}

export function recommendationBg(rec: Recommendation | null | undefined): string {
  switch (rec) {
    case "go": return "bg-green-100 text-green-800";
    case "watch": return "bg-yellow-100 text-yellow-800";
    case "pass": return "bg-red-100 text-red-800";
    default: return "bg-gray-100 text-gray-600";
  }
}

export function riskScoreColor(score: number | null | undefined): string {
  if (score == null) return "text-muted";
  if (score <= 40) return "text-green-600";
  if (score <= 65) return "text-yellow-600";
  return "text-red-600";
}

export function riskTier(score: number | null | undefined): string {
  if (score == null) return "—";
  if (score <= 25) return "Low";
  if (score <= 40) return "Moderate";
  if (score <= 65) return "Elevated";
  return "High";
}

export function dealStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    uploading: "Uploading",
    extracting: "Extracting",
    review: "Needs Review",
    underwriting: "Underwriting",
    complete: "Complete",
    archived: "Archived",
  };
  return labels[status] ?? status;
}

export function dealStatusColor(status: string): string {
  const colors: Record<string, string> = {
    uploading: "bg-blue-100 text-blue-700",
    extracting: "bg-purple-100 text-purple-700",
    review: "bg-amber-100 text-amber-700",
    underwriting: "bg-indigo-100 text-indigo-700",
    complete: "bg-green-100 text-green-700",
    archived: "bg-gray-100 text-gray-500",
  };
  return colors[status] ?? "bg-gray-100 text-gray-500";
}
