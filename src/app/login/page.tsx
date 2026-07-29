"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  // "/" resolves role-aware (ADMIN → console, OWNER/MANAGER → yard app).
  const callbackUrl = params.get("callbackUrl") || "/";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    const res = await signIn("credentials", { email, password, redirect: false });
    setLoading(false);
    if (res?.error) {
      setErr("Invalid email or password.");
      return;
    }
    router.push(callbackUrl);
    router.refresh();
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
        <div className="mod">SCRAP FLOW · YARD OS</div>

        {err && <div className="err">{err}</div>}

        <form onSubmit={submit}>
          <div className="field">
            <label>Email</label>
            <input
              type="email"
              autoComplete="username"
              inputMode="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@veloce.in"
              required
            />
          </div>
          <div className="field">
            <label>Password</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
            />
          </div>
          <button className="cta" type="submit" disabled={loading}>
            {loading ? "SIGNING IN…" : "SIGN IN"}
          </button>
        </form>

        <div className="demo">
          Demo · owner@veloce.in / owner123
          <br />
          Demo · manager@veloce.in / manager123
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="login" />}>
      <LoginForm />
    </Suspense>
  );
}
