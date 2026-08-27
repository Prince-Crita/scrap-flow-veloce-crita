"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useAdminRealtime } from "@/frontend/components/admin/admin-realtime";
import { ADMIN_ICONS } from "@/frontend/components/admin/icons";
import { ADMIN_NAV, ADMIN_NAV_GROUPS, isActive } from "@/frontend/components/admin/nav-items";

/**
 * Desktop console navigation.
 *
 * Grouped so the console reads as three concerns rather than a flat list: what is
 * happening now, what I administer, and what was done.
 *
 * Below 1000px this whole nav is replaced by `AdminBottomNav` — see admin.css,
 * which hides `.aNav` there rather than trying to squeeze a sidebar into a strip.
 */
export function AdminSidebar({ name, email }: { name?: string | null; email?: string | null }) {
  const pathname = usePathname();
  const { connected } = useAdminRealtime();

  return (
    <aside className="aSide">
      <div className="aBrand">
        <svg width="30" height="23" viewBox="0 0 34 26" fill="none">
          <path d="M2 1 L13 13 L2 25 L8 25 L19 13 L8 1 Z" fill="#2E8B4F" />
          <path d="M14 1 L25 13 L14 25 L20 25 L31 13 L20 1 Z" fill="#2E8B4F" opacity=".55" />
        </svg>
        <div>
          <span className="wm">Veloce</span>
          <span className="mod">SCRAP FLOW · ADMIN</span>
        </div>
      </div>

      <nav className="aNav">
        {ADMIN_NAV_GROUPS.map((group) => {
          const items = ADMIN_NAV.filter((n) => n.group === group);
          if (items.length === 0) return null;
          return (
            <div key={group} style={{ display: "contents" }}>
              <div className="aNavGroup">{group}</div>
              {items.map((n) => {
                const Icon = ADMIN_ICONS[n.icon];
                return (
                  <Link key={n.href} href={n.href} className={isActive(pathname, n) ? "on" : ""}>
                    <span className="aIco">
                      <Icon size={18} />
                    </span>
                    {n.label}
                  </Link>
                );
              })}
            </div>
          );
        })}
      </nav>

      <div className="aSideFoot">
        <span className={`aLive ${connected ? "on" : ""}`}>
          <i />
          {connected ? "Live" : "Reconnecting"}
        </span>
        <b style={{ marginTop: 10 }}>{name ?? "Platform Admin"}</b>
        {/* Wrapped so the narrow-viewport rule can hide it with `display: none`
            rather than `font-size: 0` — zero-size text stays in the a11y tree
            and is read aloud while being invisible. */}
        <span className="em">{email}</span>
        <button onClick={() => signOut({ callbackUrl: "/login" })}>Sign out</button>
      </div>
    </aside>
  );
}
