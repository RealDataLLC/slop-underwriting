"use client";

import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DealStatus } from "@/lib/types";

const STEPS: { key: DealStatus; label: string }[] = [
  { key: "uploading", label: "Uploading" },
  { key: "extracting", label: "Extracting" },
  { key: "review", label: "Review" },
  { key: "underwriting", label: "Underwriting" },
  { key: "complete", label: "Complete" },
];

interface StatusPipelineProps {
  currentStatus: DealStatus;
  onNavigate?: (status: DealStatus) => void;
}

export function StatusPipeline({ currentStatus, onNavigate }: StatusPipelineProps) {
  const currentIndex = STEPS.findIndex((s) => s.key === currentStatus);

  return (
    <div className="flex items-center gap-0 w-full">
      {STEPS.map((step, i) => {
        const isComplete = i < currentIndex;
        const isCurrent = i === currentIndex;
        const isFuture = i > currentIndex;
        // Allow clicking completed steps and the review step (if past it)
        const isClickable =
          onNavigate &&
          isComplete &&
          step.key !== "extracting" &&
          step.key !== "underwriting";

        return (
          <div key={step.key} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1.5">
              <button
                type="button"
                disabled={!isClickable}
                onClick={() => isClickable && onNavigate(step.key)}
                className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-all",
                  isComplete && "bg-accent border-accent text-white",
                  isCurrent && "bg-accent-light border-accent text-accent",
                  isFuture && "bg-gray-100 border-gray-300 text-gray-400",
                  isClickable &&
                    "cursor-pointer hover:ring-2 hover:ring-accent/40 hover:scale-110 active:scale-95",
                  !isClickable && "cursor-default"
                )}
                title={isClickable ? `Go back to ${step.label}` : undefined}
              >
                {isComplete ? <Check className="w-4 h-4" /> : i + 1}
              </button>
              <span
                className={cn(
                  "text-xs font-medium whitespace-nowrap",
                  isComplete && "text-accent",
                  isCurrent && "text-accent",
                  isFuture && "text-muted",
                  isClickable && "cursor-pointer hover:underline"
                )}
                onClick={() => isClickable && onNavigate(step.key)}
              >
                {step.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  "flex-1 h-0.5 mx-2 mt-[-1.25rem]",
                  i < currentIndex ? "bg-accent" : "bg-gray-200"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
