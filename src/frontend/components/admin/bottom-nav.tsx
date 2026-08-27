"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { ADMIN_ICONS, IconClose, IconSignOut } from "@/frontend/components/admin/icons";
import { ADMIN_NAV, isActive } from "@/frontend/components/admin/nav-items";

/**
 * Admin navigation for tablet and mobile.
 *
 * Follows the yard app's convention — a fixed bottom bar, thumb-reachable —
 * because that is what the same people already use on the same devices. It is
 * NOT the yard app's component: the admin bar carries line icons, a "More"
 * overflow, and the account controls that the sidebar owns on desktop.
 *
 * Four primary destinations plus More. Five equal tabs is the point at which
 * labels start truncating on a 360px screen, and "Audit Log" is the item you
 * navigate to deliberately rather than flick between — so it lives in the sheet.
 *
 * Rendered on every admin page and hidden above 1000px by CSS, so desktop is
 * untouched.
 */
export function AdminBottomNav({ name, email }: { name?: string | null; email?: string | null }) {
  const pathname = usePathname();
  const [openMore, setOpenMore] = useState(false);

  const primary = ADMIN_NAV.filter((n) => n.primary);
  const overflow = ADMIN_NAV.filter((n) => !n.primary);
  const overflowActive = overflow.some((n) => isActive(pathname, n));

  // A route change must close the sheet, or tapping an item in it leaves the
  // overlay covering the page you just navigated to.
  useEffect(() => {
    setOpenMore(false);
  }, [pathname]);

  // Escape closes, and while the sheet is open the page behind must not scroll.
  useEffect(() => {
    if (!openMore) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenMore(false);
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [openMore]);

  const MoreIcon = ADMIN_ICONS.more;

  return (
    <>
      <nav className="aTabbar" aria-label="Admin navigation">
        {primary.map((n) => {
          const Icon = ADMIN_ICONS[n.icon];
          return (
            <Link
              key={n.href}
              href={n.href}
              className={isActive(pathname, n) ? "on" : ""}
              aria-current={isActive(pathname, n) ? "page" : undefined}
            >
              <span className="aTabIco">
                <Icon size={20} />
              </span>
              {n.short}
            </Link>
          );
        })}
        <button
          type="button"
          className={`aTabMore ${openMore || overflowActive ? "on" : ""}`}
          onClick={() => setOpenMore((v) => !v)}
          aria-expanded={openMore}
          aria-haspopup="menu"
        >
          <span className="aTabIco">
            <MoreIcon size={20} />
          </span>
          More
        </button>
      </nav>

      {openMore && (
        <div className="aMoreScrim" onClick={() => setOpenMore(false)}>
          <div
            className="aMoreSheet"
            role="menu"
            aria-label="More"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="aMoreHead">
              <div>
                <b>{name ?? "Platform Admin"}</b>
                {email && <span>{email}</span>}
              </div>
              <button type="button" onClick={() => setOpenMore(false)} aria-label="Close">
                <IconClose size={18} />
              </button>
            </div>

            {overflow.map((n) => {
              const Icon = ADMIN_ICONS[n.icon];
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  role="menuitem"
                  className={`aMoreItem ${isActive(pathname, n) ? "on" : ""}`}
                >
                  <Icon size={19} />
                  {n.label}
                </Link>
              );
            })}

            <button
              type="button"
              role="menuitem"
              className="aMoreItem danger"
              onClick={() => signOut({ callbackUrl: "/login" })}
            >
              <IconSignOut size={19} />
              Sign out
            </button>
          </div>
        </div>
      )}
    </>
  );
}
