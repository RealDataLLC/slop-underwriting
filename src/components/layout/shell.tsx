"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, LayoutDashboard } from "lucide-react";
import { cn } from "@/lib/utils";

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <>
      <header className="border-b border-border bg-card">
        <div className="max-w-7xl mx-auto px-6 flex items-center h-14 gap-8">
          <Link href="/" className="flex items-center gap-2 font-semibold text-accent">
            <Building2 className="w-5 h-5" />
            <span className="text-base tracking-tight">Slop</span>
          </Link>
          <nav className="flex items-center gap-1 text-sm">
            <Link
              href="/"
              className={cn(
                "px-3 py-1.5 rounded-md transition-colors",
                pathname === "/"
                  ? "bg-accent-light text-accent font-medium"
                  : "text-muted hover:text-foreground"
              )}
            >
              <span className="flex items-center gap-1.5">
                <LayoutDashboard className="w-4 h-4" />
                Projects
              </span>
            </Link>
          </nav>
          <div className="ml-auto text-xs text-muted">
            nelson@subtlerealestate.com
          </div>
        </div>
      </header>
      <main className="flex-1">
        <div className="max-w-7xl mx-auto px-6 py-8">
          {children}
        </div>
      </main>
    </>
  );
}
