import type { AdminIconName } from "@/frontend/components/admin/icons";

export type AdminNavItem = {
  href: string;
  icon: AdminIconName;
  label: string;
  /** Shorter label for the mobile bar, where 5 items share the width. */
  short: string;
  exact?: boolean;
  /** Grouping for the desktop sidebar only. */
  group: "Monitor" | "Manage" | "Govern";
  /**
   * On tablet/mobile the bottom bar carries the four pages an admin actually
   * moves between; everything else lives behind "More". Audit Log is the one
   * that goes — it is where you go deliberately, not where you flick to.
   */
  primary: boolean;
};

/** Single source of truth for admin navigation — sidebar and mobile bar. */
export const ADMIN_NAV: AdminNavItem[] = [
  { href: "/admin", icon: "overview", label: "Overview", short: "Overview", exact: true, group: "Monitor", primary: true },
  { href: "/admin/analytics", icon: "analytics", label: "Analytics", short: "Analytics", group: "Monitor", primary: true },
  { href: "/admin/yards", icon: "yards", label: "Yards", short: "Yards", group: "Manage", primary: true },
  { href: "/admin/users", icon: "users", label: "Users", short: "Users", group: "Manage", primary: true },
  { href: "/admin/audit", icon: "audit", label: "Audit Log", short: "Audit", group: "Govern", primary: false },
];

export const ADMIN_NAV_GROUPS: AdminNavItem["group"][] = ["Monitor", "Manage", "Govern"];

export function isActive(pathname: string, item: AdminNavItem): boolean {
  return item.exact ? pathname === item.href : pathname.startsWith(item.href);
}
