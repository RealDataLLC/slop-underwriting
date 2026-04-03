import { cn } from "@/lib/utils";

type BadgeVariant = "default" | "go" | "watch" | "pass" | "status";

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  default: "bg-gray-100 text-gray-700",
  go: "bg-green-100 text-green-800",
  watch: "bg-yellow-100 text-yellow-800",
  pass: "bg-red-100 text-red-800",
  status: "bg-accent-light text-accent",
};

export function Badge({ variant = "default", children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        variantStyles[variant],
        className
      )}
    >
      {children}
    </span>
  );
}
