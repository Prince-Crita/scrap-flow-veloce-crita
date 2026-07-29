import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { adminDb } from "@/lib/tenant";
import { getYardContext } from "@/lib/yard-context";
import { UIProvider, ToastHost, PartyHost, ConfirmHost } from "@/components/ui-provider";
import { AppHeader, Ticker, XpBar } from "@/components/app-chrome";
import { BottomNav } from "@/components/bottom-nav";
import { RealtimeProvider } from "@/components/realtime/provider";
import { ImpersonationBanner } from "@/components/admin/impersonation-banner";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // Resolves tenancy the same way the API guards do. An ADMIN without an active
  // "Enter Yard" session has no yard for these screens to scope to.
  const ctx = await getYardContext();
  if (!ctx) redirect(session.user.role === "ADMIN" ? "/admin/yards" : "/login");

  const user = await adminDb.user.findUnique({
    where: { id: session.user.id },
    select: { xp: true, level: true, streak: true, role: true, name: true },
  });
  if (!user) redirect("/login");

  // Only for the profile popup. Read here rather than in a client fetch so the
  // header has it on first paint and no extra round trip is needed.
  //
  // `Yard.ownerName` is an optional free-text field and is unset for yards
  // created before it existed, so fall back to the name of the yard's actual
  // OWNER user — derived from real data rather than left blank or invented.
  const yard = await adminDb.yard.findUnique({
    where: { id: ctx.yardId },
    select: {
      ownerName: true,
      users: {
        where: { role: "OWNER", active: true },
        select: { name: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });
  const ownerName = yard?.ownerName?.trim() || yard?.users[0]?.name || null;

  return (
    <UIProvider initialXp={user.xp} initialLevel={user.level} initialStreak={user.streak}>
      <RealtimeProvider currentUserId={session.user.id}>
        <div className="phone" id="phoneFrame">
          <div className="hazard" />
          {/* Rendered only for an impersonating ADMIN — the yard's own Owner and
              Manager never receive this element at all. */}
          {ctx.impersonating && (
            <ImpersonationBanner
              yardName={ctx.yardName}
              yardCode={ctx.yardCode}
              startedAt={ctx.impersonationStartedAt?.toISOString() ?? null}
            />
          )}
          <AppHeader
            profile={{
              name: user.name,
              role: user.role,
              yardName: ctx.yardName,
              yardCode: ctx.yardCode,
              ownerName,
            }}
          />
          <Ticker />
          <XpBar />
          <div className="screens">
            <section className="screen">{children}</section>
          </div>
          <BottomNav role={user.role} />
          <ToastHost />
          <PartyHost />
          <ConfirmHost />
        </div>
      </RealtimeProvider>
    </UIProvider>
  );
}
