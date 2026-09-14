import { redirect } from "next/navigation";
import { auth } from "@/backend/auth/auth";
import { OutwardPickups } from "@/frontend/components/outward-pickups";

export const dynamic = "force-dynamic";

/**
 * Outward.
 *
 * One implementation. The allocation-driven dispatch keypad that used to live
 * here was removed along with the role fork that chose between them — there is
 * no second Outward screen, so MANAGER and ADMIN both get this dashboard and
 * the four-page dispatch workflow behind it.
 *
 * ── Why the OWNER is redirected ──────────────────────────────────────────────
 * The Owner has no Outward tab and no Outward page: dispatch is a section of
 * their Sell page, which renders this very component. So the standalone screen
 * would be a duplicate door onto work they already have in front of them, and
 * this sends them back to the one door they do have.
 *
 * ONLY the index redirects. `/outward/new`, `/outward/active`,
 * `/outward/history` and `/outward/[id]/…` stay reachable for every in-yard
 * role, because the Sell page's dispatch cards link straight into them — the
 * workflow is shared, and breaking those routes would break Sell. It also means
 * Back out of a dispatch step lands the Owner on Sell, which is where they
 * started.
 *
 * The `/api/outward/queue` and `/api/outward/dispatch` endpoints are deliberately
 * NOT removed: they are how the Owner's Sell page still reports dispatches made
 * against a buyer's allocation, and they remain covered by their own tests.
 *
 * The header, XP bar and bottom navigation come from `src/app/(app)/layout.tsx`
 * and are common to every screen, so nothing here can affect them.
 */
export default async function OutwardPage() {
  const session = await auth();
  if (session?.user?.role === "OWNER") redirect("/sell");
  return <OutwardPickups />;
}
