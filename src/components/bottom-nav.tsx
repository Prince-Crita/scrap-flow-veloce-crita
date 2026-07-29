"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { Role } from "@prisma/client";
import { can } from "@/lib/permissions";

const TABS = [
  { s: "stock", href: "/stock", ico: "📦", label: "STOCK", cap: "stock.view" },
  { s: "inward", href: "/inward", ico: "⚖️", label: "INWARD", cap: "inward.create" },
  { s: "sort", href: "/sort", ico: "🧲", label: "SORT", cap: "sort.complete" },
  { s: "sell", href: "/sell", ico: "🚚", label: "SELL", cap: "sell.view" },
  { s: "outward", href: "/outward", ico: "🏁", label: "OUTWARD", cap: "outward.dispatch" },
] as const;

export function BottomNav({ role }: { role: Role }) {
  const pathname = usePathname();
  // Driven by the shared permission matrix: MANAGER still has no SELL tab, and
  // an ADMIN inside a yard sees it because ADMIN inherits OWNER capabilities.
  const tabs = TABS.filter((t) => can(role, t.cap));
  return (
    <nav className="tabbar">
      {tabs.map((t) => {
        const active = pathname.startsWith(t.href);
        return (
          <Link key={t.s} href={t.href} className={active ? "on" : ""}>
            <span className="ico">{t.ico}</span>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
