import { redirect } from "next/navigation";
import { auth } from "@/backend/auth/auth";
import { homePathFor } from "@/shared/permissions";

/** Role-aware landing: ADMIN → console, OWNER/MANAGER → the yard app. */
export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  redirect(homePathFor(session.user.role));
}
