"use client";

import { useEffect, useState } from "react";
import { useUI, levelProgress } from "@/components/ui-provider";
import { fmt } from "@/lib/format";
import { PhonePortal } from "@/components/phone-portal";
import { ROLE_LABEL } from "@/lib/role-label";

export type Profile = {
  name: string;
  role: string;
  yardName: string;
  yardCode: string;
  ownerName: string | null;
};

/**
 * Profile popup behind the level badge.
 *
 * It exists because tapping the badge used to sign the operator out — a
 * one-tap, no-confirmation way to lose your place mid-load. The badge now opens
 * this, and only the explicit Sign Out button ends the session.
 *
 * Uses the sheet vocabulary the rest of the phone UI already speaks; no new
 * component style is introduced.
 */
export function ProfileSheet({
  open,
  onClose,
  profile,
  onSignOut,
}: {
  open: boolean;
  onClose: () => void;
  profile: Profile;
  onSignOut: () => void;
}) {
  const { xp, level, streak } = useUI();
  const { nextXp, pct } = levelProgress(xp);

  // The bar fills from zero on open so the progress reads as an animation
  // rather than a static value that was always there.
  const [fill, setFill] = useState(0);
  useEffect(() => {
    if (!open) {
      setFill(0);
      return;
    }
    const t = setTimeout(() => setFill(pct), 40);
    return () => clearTimeout(t);
  }, [open, pct]);

  if (!open) return null;

  const toNext = Math.max(0, nextXp - xp);

  return (
    <PhonePortal>
      <div className="sheetWrap" onClick={onClose}>
        <div className="sheet" onClick={(e) => e.stopPropagation()}>
          <div className="sheetHandle" />
          <div className="sheetTitle">{profile.name}</div>
          <div className="sheetStep">
            {ROLE_LABEL[profile.role] ?? profile.role} · {profile.yardName}
          </div>

          <div className="profStats">
            <div className="profStat">
              <b>{level}</b>
              <span>LEVEL</span>
            </div>
            <div className="profStat">
              <b>{fmt(xp)}</b>
              <span>XP</span>
            </div>
            <div className="profStat">
              <b>🔥 {streak}</b>
              <span>STREAK</span>
            </div>
          </div>

          <div className="xplabel" style={{ marginTop: 14 }}>
            <span>{fmt(xp)} XP</span>
            <span>
              {fmt(nextXp)} XP → Level {level + 1}
            </span>
          </div>
          <div className="xpbar">
            <i style={{ width: `${fill}%` }} />
          </div>
          <p className="hint" style={{ marginTop: 8 }}>
            {toNext > 0 ? `${fmt(toNext)} XP to level ${level + 1}` : `Level ${level + 1} unlocked`}
          </p>

          <div className="secTitle" style={{ marginTop: 18 }}>
            Yard
          </div>
          <div className="recv">
            <span>Yard</span>
            <b>{profile.yardName}</b>
          </div>
          <div className="recv">
            <span>Yard code</span>
            <b>{profile.yardCode}</b>
          </div>
          <div className="recv">
            <span>Owner</span>
            <b>{profile.ownerName ?? "—"}</b>
          </div>
          <div className="recv">
            <span>Role</span>
            <b>{ROLE_LABEL[profile.role] ?? profile.role}</b>
          </div>

          <div className="secTitle" style={{ marginTop: 18 }}>
            Achievements
          </div>
          <div className="profSoon">Coming soon — badges for streaks, sorting accuracy and sales.</div>

          <button className="cta ghost" onClick={onClose}>
            Close
          </button>
          {/* The ONLY way to sign out from here. */}
          <button className="cta danger" onClick={onSignOut}>
            Sign Out
          </button>
        </div>
      </div>
    </PhonePortal>
  );
}
