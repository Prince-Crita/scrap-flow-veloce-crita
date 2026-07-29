"use client";

import { createContext, useContext, useCallback, useEffect, useRef, useState } from "react";
import { fireConfetti, stopConfetti } from "@/lib/confetti";

/* ---------------- Level system (cumulative XP thresholds) ---------------- */
/**
 * Cumulative XP required to REACH each level (index 0 => level 1).
 *
 * Anchored to the two data points the approved prototype
 * (`scrapflow_veloce_v2-1.html`) actually states:
 *   • `let xp = 1240` with `<b id="lvl">7</b>`  → 1,240 XP is inside level 7
 *   • `<span>2,000 XP → Level 8</span>`         → level 8 begins at exactly 2,000
 *
 * So index 6 (level 7 floor) must be ≤ 1240 and index 7 (level 8 floor) must be
 * 2000. The prototype says nothing about where level 7 begins or about anything
 * past level 8; the intermediate floors and the continuation curve are ours.
 */
const BASE_THRESHOLDS = [0, 100, 250, 450, 700, 950, 1200, 2000];

function buildThresholds(max = 200): number[] {
  const t = [...BASE_THRESHOLDS];
  let delta = 1000; // first step past the prototype's level-8 anchor
  while (t.length < max) {
    t.push(t[t.length - 1] + delta);
    delta += 200; // curve keeps growing beyond level 8
  }
  return t;
}
const THRESHOLDS = buildThresholds();

export function levelForXp(xp: number): number {
  let lvl = 1;
  for (let i = 0; i < THRESHOLDS.length; i++) {
    if (xp >= THRESHOLDS[i]) lvl = i + 1;
    else break;
  }
  return lvl;
}

export function levelProgress(xp: number) {
  const level = levelForXp(xp);
  const floorXp = THRESHOLDS[level - 1];
  const nextXp = THRESHOLDS[level] ?? floorXp;
  // The prototype fills the bar as an ABSOLUTE fraction of the next level's XP
  // (`xpFill.style.width = xp/2000*100 + '%'` → 1240/2000 = 62%), not as
  // progress within the current level. Matched exactly so the rendered bar is
  // identical to the approved design.
  const pct = nextXp > 0 ? Math.min(100, (xp / nextXp) * 100) : 100;
  return { level, floorXp, nextXp, pct };
}

/* ---------------- Types ---------------- */
type PartyData = { icon: string; title: string; sub: string; xp: string };
type ConfirmOpts = { title?: string; message: string; confirmLabel?: string; danger?: boolean };
type ConfirmState = ConfirmOpts & { resolve: (v: boolean) => void };

interface UICtx {
  xp: number;
  level: number;
  streak: number;
  toast: (msg: string) => void;
  party: (icon: string, title: string, sub: string, xp: string) => void;
  bump: (n: number) => Promise<{ leveled: boolean }>;
  confirm: (opts: ConfirmOpts) => Promise<boolean>;
  _toastMsg: string;
  _toastShow: boolean;
  _party: PartyData | null;
  _closeParty: () => void;
  _confirm: ConfirmState | null;
  _resolveConfirm: (v: boolean) => void;
}

const Ctx = createContext<UICtx | null>(null);

export function useUI() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useUI must be used within <UIProvider>");
  return c;
}

export function UIProvider({
  initialXp,
  initialStreak,
  children,
}: {
  initialXp: number;
  initialLevel?: number; // retained for compatibility; level is derived from xp
  initialStreak: number;
  children: React.ReactNode;
}) {
  const [xp, setXp] = useState(initialXp);
  // The server owns the streak (it evaluates calendar days in the yard's
  // timezone); the client just reflects whatever the last /api/xp call returned.
  const [streak, setStreak] = useState(initialStreak);
  const level = levelForXp(xp); // single source of truth

  const [toastMsg, setToastMsg] = useState("");
  const [toastShow, setToastShow] = useState(false);
  const [partyData, setPartyData] = useState<PartyData | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const tmr = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    setToastShow(true);
    if (tmr.current) clearTimeout(tmr.current);
    tmr.current = setTimeout(() => setToastShow(false), 2200);
  }, []);

  const party = useCallback((icon: string, title: string, sub: string, xpTxt: string) => {
    setPartyData({ icon, title, sub, xp: xpTxt });
    if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate([60, 40, 60]);
  }, []);

  const closeParty = useCallback(() => {
    setPartyData(null);
    stopConfetti();
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOpts) =>
      new Promise<boolean>((resolve) => {
        setConfirmState({ ...opts, resolve });
      }),
    []
  );

  const resolveConfirm = useCallback(
    (v: boolean) => {
      confirmState?.resolve(v);
      setConfirmState(null);
    },
    [confirmState]
  );

  const bump = useCallback(
    async (n: number) => {
      const newXp = xp + n;
      const after = levelForXp(newXp);
      const leveled = after > levelForXp(xp);
      setXp(newXp);
      // persist (best-effort — gamification never blocks work)
      let streakExtended = false;
      try {
        const res = await fetch("/api/xp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ xp: newXp, level: after }),
        });
        if (res.ok) {
          const data = (await res.json()) as { streak?: number; streakExtended?: boolean };
          if (typeof data.streak === "number") setStreak(data.streak);
          streakExtended = !!data.streakExtended;
        }
      } catch {
        /* ignore */
      }
      // A level-up outranks a streak bump — never stack two celebrations.
      if (streakExtended && !leveled) {
        setTimeout(() => party("🔥", "STREAK EXTENDED!", "Another day in the yard · keep it going", "🔥 streak"), 600);
      }
      if (leveled) {
        setTimeout(
          () => party("🎉", "LEVEL UP!", `Yard Level ${after} · keep the streak alive`, `Level ${after}`),
          600
        );
      }
      return { leveled };
    },
    [xp, party]
  );

  const value: UICtx = {
    xp,
    level,
    streak,
    toast,
    party,
    bump,
    confirm,
    _toastMsg: toastMsg,
    _toastShow: toastShow,
    _party: partyData,
    _closeParty: closeParty,
    _confirm: confirmState,
    _resolveConfirm: resolveConfirm,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Toast pill — rendered inside the phone frame. */
export function ToastHost() {
  const { _toastMsg, _toastShow } = useUI();
  return <div className={`toast${_toastShow ? " show" : ""}`}>{_toastMsg}</div>;
}

/** Celebration overlay + confetti — rendered inside the phone frame. */
export function PartyHost() {
  const { _party, _closeParty } = useUI();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (_party && canvasRef.current) fireConfetti(canvasRef.current);
  }, [_party]);

  return (
    <div className={`party${_party ? " show" : ""}`} aria-hidden={!_party}>
      <canvas ref={canvasRef} />
      {_party && (
        <div className="partyCard">
          <div className="big">{_party.icon}</div>
          <h2>{_party.title}</h2>
          <p>{_party.sub}</p>
          <div className="xpwin">{_party.xp}</div>
          <button onClick={_closeParty}>COLLECT</button>
        </div>
      )}
    </div>
  );
}

/** In-app confirmation modal — replaces native confirm(). Veloce-styled. */
export function ConfirmHost() {
  const { _confirm, _resolveConfirm } = useUI();
  return (
    <div className={`party${_confirm ? " show" : ""}`} aria-hidden={!_confirm}>
      {_confirm && (
        <div className="partyCard confirmCard">
          {_confirm.title && <h2>{_confirm.title}</h2>}
          <p className="confirmMsg">{_confirm.message}</p>
          <div className="confirmBtns">
            <button className="confirmCancel" onClick={() => _resolveConfirm(false)}>
              Cancel
            </button>
            <button
              className={_confirm.danger ? "confirmGo danger" : "confirmGo"}
              onClick={() => _resolveConfirm(true)}
            >
              {_confirm.confirmLabel ?? "Confirm"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
