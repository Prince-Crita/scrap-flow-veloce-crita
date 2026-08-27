import { redirect } from "next/navigation";
import { auth } from "@/backend/auth/auth";
import "@/frontend/styles/admin.css";
import { AdminShellAttr } from "@/frontend/components/admin/shell-attr";
import { AdminSidebar } from "@/frontend/components/admin/sidebar";
import { AdminBottomNav } from "@/frontend/components/admin/bottom-nav";
import { AdminRealtimeProvider } from "@/frontend/components/admin/admin-realtime";
import { AdminMainTransition } from "@/frontend/components/route-transition";

export const dynamic = "force-dynamic";

/**
 * Admin console shell. Desktop-first, responsive, no phone frame.
 *
 * `data-shell="admin"` on <body> is what activates src/frontend/styles/admin.css. It is
 * server-rendered by the root layout from a middleware header, so there is no
 * flash and no dependency on JavaScript. AdminShellAttr only keeps the attribute
 * correct across client-side navigation out of the console.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");
  // Defence in depth: middleware already blocks /admin for non-admins.
  if (session.user.role !== "ADMIN") redirect("/stock");

  return (
    <>
      <AdminShellAttr />
      <AdminRealtimeProvider>
        <div className="aShell">
          <AdminSidebar name={session.user.name} email={session.user.email} />
          <AdminMainTransition>{children}</AdminMainTransition>
          {/* Tablet/mobile navigation. Hidden above 1000px, so desktop is
              untouched — see the `.aTabbar` rules in admin.css. */}
          <AdminBottomNav name={session.user.name} email={session.user.email} />
        </div>
      </AdminRealtimeProvider>
    </>
  );
}
