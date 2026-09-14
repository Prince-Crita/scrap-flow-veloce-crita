"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  DISPATCH_STEPS,
  stepStatus,
  stateLabel,
  type DispatchProgress,
  type DispatchStage,
  type DispatchState,
} from "@/shared/dispatch-stage";

/**
 * The furniture every dispatch workflow page shares: a back action, the step
 * rail, and the status pill.
 *
 * Pages, not modals — the workflow is four screens deep on a phone, and a stack
 * of dialogs that deep cannot be backed out of predictably. Each stage is a real
 * route, so the device's own Back button walks the workflow, a refresh reloads
 * the step the operator was on, and a half-finished dispatch can be linked to.
 */

/** The rail. Reads as a rail, not a list: a line with points on it. */
export function DispatchRail({ progress }: { progress: DispatchProgress }) {
  return (
    <ol className="dRail" aria-label="Dispatch progress">
      {DISPATCH_STEPS.map((s) => {
        const st = stepStatus(progress, s.key);
        return (
          <li key={s.key} className={`dRailStep is-${st}`}>
            <span className="dRailMark" aria-hidden>
              {st === "done" ? "✓" : st === "current" ? "●" : "○"}
            </span>
            <span className="dRailLbl">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** ACTIVE / IN TRANSIT / COMPLETED, in the app's existing chip language. */
export function DispatchStatePill({ state }: { state: DispatchState }) {
  return <span className={`dPill is-${state.toLowerCase()}`}>{stateLabel(state)}</span>;
}

/**
 * The header each workflow page carries: where you are, how to go back, and
 * which dispatch this is. `backHref` is explicit rather than `router.back()`
 * alone, so arriving directly on a step (a resumed dispatch, a refresh, a
 * shared link) still has a sane previous screen.
 */
export function DispatchStepHeader({
  title,
  step,
  backHref,
  refCode,
  progress,
}: {
  title: string;
  step: DispatchStage;
  backHref: string;
  refCode?: string | null;
  progress?: DispatchProgress | null;
}) {
  const router = useRouter();
  const idx = DISPATCH_STEPS.findIndex((s) => s.step === step) + 1;
  const total = DISPATCH_STEPS.filter((s) => s.step).length;
  const shown = DISPATCH_STEPS.filter((s) => s.step).findIndex((s) => s.step === step) + 1;

  return (
    <>
      <div className="dTopRow">
        <button
          type="button"
          className="dBack"
          aria-label="Back"
          onClick={() => {
            // Prefer the real history entry so the animation and scroll
            // position match the device Back button; fall back to the explicit
            // href when this page was opened directly.
            if (window.history.length > 1) router.back();
            else router.push(backHref);
          }}
        >
          ‹ Back
        </button>
        {refCode && <span className="dRef">{refCode}</span>}
      </div>
      <div className="secTitle">{title}</div>
      <p className="dStepOf">
        Step {shown || idx} of {total}
      </p>
      {progress && <DispatchRail progress={progress} />}
    </>
  );
}

/** A row of the three dashboard actions, reusing the Stock card language. */
export function DispatchActionCard({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Link href={href} className="sqCard actionCard">
      <span className="chipIcon actionIcon">{children}</span>
      <span className="actionLbl">{label}</span>
    </Link>
  );
}
