"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { sendJson, ApiError } from "@/lib/fetcher";

/**
 * Forced password change after an admin reset.
 *
 * Deliberately reuses the existing `.login` styles — no new CSS, no new visual
 * language, and it renders outside the phone frame exactly like the login screen.
 */
export default function ChangePasswordPage() {
  const router = useRouter();
  const { update } = useSession();

  const [currentPassword, setCurrent] = useState("");
  const [newPassword, setNew] = useState("");
  const [confirmPassword, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");

    if (newPassword.length < 8) {
      setErr("New password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setErr("New passwords do not match.");
      return;
    }

    setLoading(true);
    try {
      await sendJson("/api/account/password", { currentPassword, newPassword });
      // Clear the flag in the JWT so middleware stops redirecting here.
      await update({ mustChangePassword: false });
      router.push("/");
      router.refresh();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Could not change password.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login">
      <div className="hazard" />
      <div className="body">
        <svg width="46" height="34" viewBox="0 0 34 26" fill="none">
          <path d="M2 1 L13 13 L2 25 L8 25 L19 13 L8 1 Z" fill="#2E8B4F" />
          <path d="M14 1 L25 13 L14 25 L20 25 L31 13 L20 1 Z" fill="#2E8B4F" opacity=".55" />
        </svg>
        <h1>Veloce</h1>
        <div className="mod">SET A NEW PASSWORD</div>

        {err && <div className="err">{err}</div>}

        <form onSubmit={submit}>
          <div className="field">
            <label>Current password</label>
            <input
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <div className="field">
            <label>New password</label>
            <input
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
              placeholder="At least 8 characters"
              required
            />
          </div>
          <div className="field">
            <label>Confirm new password</label>
            <input
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <button className="cta" type="submit" disabled={loading}>
            {loading ? "SAVING…" : "SAVE PASSWORD"}
          </button>
        </form>

        <div className="demo">Your administrator reset this password. Choose a new one to continue.</div>
      </div>
    </div>
  );
}
