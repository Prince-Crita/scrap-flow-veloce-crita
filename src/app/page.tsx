import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { homePathFor } from "@/lib/permissions";

/** Role-aware landing: ADMIN → console, OWNER/MANAGER → the yard app. */
export default async function Home() {
  const session = await auth();
  if (!session?.user) redirect("/login");
  redirect(homePathFor(session.user.role));
}
