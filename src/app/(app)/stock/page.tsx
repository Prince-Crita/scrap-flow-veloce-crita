import { auth } from "@/backend/auth/auth";
import { StockScreen } from "@/frontend/components/stock-screen";

export const dynamic = "force-dynamic";

/**
 * Server shell for the Stock screen — it exists only to read the role.
 *
 * The Owner opens on the yard dashboard and steps down into the material
 * hierarchy; the Supervisor opens on the categories themselves. Resolving that
 * here rather than in a client fetch means the right first screen paints
 * immediately, with no flash of the wrong one.
 *
 * The (app) layout already redirects an unauthenticated visitor, so the fallback
 * below is only a type guard — and it falls back to the dashboard-less role, so
 * a missing session can never reveal the Owner view.
 */
export default async function StockPage() {
  const session = await auth();
  return <StockScreen role={session?.user?.role ?? "MANAGER"} />;
}
