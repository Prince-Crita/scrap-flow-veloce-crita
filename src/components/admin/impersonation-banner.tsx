"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { sendJson } from "@/lib/fetcher";

/**
 * Shown at the top of the phone frame while an ADMIN is inside a yard.
 *
 * Rendered by the yard layout ONLY when the server has confirmed an active
 * impersonation session for the signed-in admin. The yard's own Owner and
 * Manager never receive this element in their HTML at all — their session is not
 * an admin session, so the branch that renders it is never taken. Nothing about
 * admin presence is exposed to them through the DOM, an API response, or a
 * realtime event.
 */
export function ImpersonationBanner({
  yardName,
  yardCode,
  startedAt,
}: {
  yardName: string;
  yardCode: string;
  startedAt: string | null;
}) {
  const router = useRouter();
  const [leaving, setLeaving] = useState(false);
  const [elapsed, setElapsed] = useState("");

  useEffect(() => {
    if (!startedAt) return;
    const start = new Date(startedAt).getTime();
    const tick = () => {
      const s = Math.max(0, Math.floor((Date.now() - start) / 1000));
      const m = Math.floor(s / 60);
      setElapsed(m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  async function exit() {
    setLeaving(true);
    try {
      await sendJson("/api/admin/impersonate", undefined, "DELETE");
      // Full navigation: the phone shell must be torn down and the admin shell
      // re-established, including the body[data-shell] attribute.
      window.location.href = "/admin/yards";
    } catch {
      setLeaving(false);
      router.refresh();
    }
  }

  return (
    <div className="impBanner">
      <span className="dot" />
      <span className="txt">
        <b>Admin view</b>
        <span>
          {yardName} · {yardCode}
        </span>
      </span>
      {elapsed && <span className="elapsed">{elapsed}</span>}
      <button onClick={exit} disabled={leaving}>
        {leaving ? "Exiting…" : "Exit"}
      </button>
    </div>
  );
}
