import { redirect } from "next/navigation";
import { auth } from "@/auth";
import "@/styles/admin.css";
import { AdminShellAttr } from "@/components/admin/shell-attr";
import { AdminSidebar } from "@/components/admin/sidebar";
import { AdminBottomNav } from "@/components/admin/bottom-nav";
import { AdminRealtimeProvider } from "@/components/admin/admin-realtime";

export const dynamic = "force-dynamic";

/**
 * Admin console shell. Desktop-first, responsive, no phone frame.
 *
 * `data-shell="admin"` on <body> is what activates src/styles/admin.css. It is
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
          <main className="aMain">{children}</main>
          {/* Tablet/mobile navigation. Hidden above 1000px, so desktop is
              untouched — see the `.aTabbar` rules in admin.css. */}
          <AdminBottomNav name={session.user.name} email={session.user.email} />
        </div>
      </AdminRealtimeProvider>
    </>
  );
}
