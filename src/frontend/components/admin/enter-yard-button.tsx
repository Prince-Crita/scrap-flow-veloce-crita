"use client";

import { useState } from "react";
import { sendJson, ApiError } from "@/frontend/lib/api-client";

/**
 * "Enter Yard" — opens the yard's own mobile UI as that yard's Owner would see
 * it, for troubleshooting and verification. Audited start to finish
 * (ImpersonationSession + two AuditLog entries).
 */
export function EnterYardButton({
  yardId,
  yardName,
  disabled,
  size = "sm",
  onError,
}: {
  yardId: string;
  yardName: string;
  disabled?: boolean;
  size?: "sm" | "md";
  onError?: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function enter() {
    setBusy(true);
    try {
      await sendJson("/api/admin/impersonate", { yardId });
      // Hard navigation so the admin CSS shell is fully replaced by the phone UI.
      window.location.href = "/stock";
    } catch (e) {
      setBusy(false);
      onError?.(e instanceof ApiError ? e.message : `Could not enter ${yardName}`);
    }
  }

  return (
    <button
      className={`aBtn warn${size === "sm" ? " sm" : ""}`}
      onClick={enter}
      disabled={busy || disabled}
      title={disabled ? "Yard is inactive" : `Open ${yardName} as its owner`}
    >
      {busy ? "Entering…" : "↪ Enter Yard"}
    </button>
  );
}
