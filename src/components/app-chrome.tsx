"use client";

import { useState } from "react";
import { signOut } from "next-auth/react";
import { useUI, levelProgress } from "@/components/ui-provider";
import { fmt } from "@/lib/format";
import { ProfileSheet, type Profile } from "@/components/profile-sheet";

/** Ring geometry. r=19 matches the SVG below; keep them in step. */
const RING_R = 19;
export const RING_C = 2 * Math.PI * RING_R;

export function AppHeader({ profile }: { profile: Profile }) {
  const { streak, level, xp, confirm } = useUI();
  const [profileOpen, setProfileOpen] = useState(false);
  const { pct } = levelProgress(xp);

  // The ring used to carry a hardcoded dasharray/dashoffset, so it showed the
  // same arc at every XP total. Deriving the offset from the real progress is
  // what makes it move; the CSS transition is what makes it move smoothly when
  // XP is awarded.
  const dashOffset = RING_C * (1 - Math.max(0, Math.min(100, pct)) / 100);

  async function handleSignOut() {
    const ok = await confirm({
      title: "Sign out",
      message: "Sign out of Scrap Flow?",
      confirmLabel: "Sign out",
      danger: true,
    });
    if (ok) signOut({ callbackUrl: "/login" });
  }

  return (
    <header>
      <div className="vlogo">
        <svg width="34" height="26" viewBox="0 0 34 26" fill="none">
          <path d="M2 1 L13 13 L2 25 L8 25 L19 13 L8 1 Z" fill="#2E8B4F" />
          <path d="M14 1 L25 13 L14 25 L20 25 L31 13 L20 1 Z" fill="#2E8B4F" opacity=".55" />
        </svg>
        <div>
          <span className="wm">Veloce</span>
          <span className="mod">SCRAP FLOW · YARD OS</span>
        </div>
      </div>
      <div className="streak">
        <b>🔥 {streak}</b>
        <span>STREAK</span>
      </div>
      <div className="avatarWrap">
        {/* Opens the profile popup. Signing out is deliberately NOT wired here
            any more — a mis-tap on the level badge used to end the session. */}
        <button
          className="avatar"
          title={`Level ${level} · ${Math.round(pct)}% to level ${level + 1}`}
          aria-label={`Profile — level ${level}`}
          onClick={() => setProfileOpen(true)}
        >
          <svg viewBox="0 0 42 42">
            <circle cx="21" cy="21" r={RING_R} fill="none" stroke="#234933" strokeWidth="3" />
            <circle
              className="ringFill"
              cx="21"
              cy="21"
              r={RING_R}
              fill="none"
              stroke="#F59E2B"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray={RING_C}
              strokeDashoffset={dashOffset}
              transform="rotate(-90 21 21)"
            />
          </svg>
          <b>{level}</b>
        </button>
        <button className="signoutTiny" onClick={handleSignOut}>
          Sign out
        </button>
      </div>

      <ProfileSheet
        open={profileOpen}
        onClose={() => setProfileOpen(false)}
        profile={profile}
        onSignOut={handleSignOut}
      />
    </header>
  );
}

const RATES = [
  { m: "PET White", v: "₹52,000", d: "up", n: "▲ 0.4" },
  { m: "PET Green", v: "₹42,000", d: "dn", n: "▼ 1.1" },
  { m: "MS HMS-1", v: "₹34,500", d: "up", n: "▲ 1.2" },
  { m: "MS HMS-2", v: "₹34,000", d: "up", n: "▲ 0.8" },
  { m: "MS Super", v: "₹35,500", d: "dn", n: "▼ 0.3" },
  { m: "MS Bazar", v: "₹33,500", d: "up", n: "▲ 2.1" },
  { m: "MS Commercial", v: "₹29,000", d: "up", n: "▲ 0.5" },
];

export function Ticker() {
  return (
    <div className="ticker">
      <div className="lbl">
        LIVE
        <br />
        RATES
      </div>
      <div className="tk">
        {RATES.map((r) => (
          <span key={r.m}>
            {r.m} <b>{r.v}</b> <i className={r.d}>{r.n}</i>
          </span>
        ))}
      </div>
    </div>
  );
}

export function XpBar() {
  const { xp } = useUI();
  const { level, nextXp, pct } = levelProgress(xp);
  return (
    <>
      <div className="xplabel">
        <span>{fmt(xp)} XP</span>
        <span>
          {fmt(nextXp)} XP → Level {level + 1}
        </span>
      </div>
      <div className="xpbar">
        <i style={{ width: `${pct}%` }} />
      </div>
    </>
  );
}
