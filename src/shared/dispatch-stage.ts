/**
 * The Supervisor/Owner dispatch workflow, in one place.
 *
 * Fleet Management → Materials → In Transit → Proof of Dispatch → Completed.
 *
 * Both the API and every screen import from here, so "which step is this
 * dispatch on", "where does Continue go" and "may this transition happen" have
 * exactly one answer. Deriving it in two places is how a resumed dispatch ends
 * up being sent back to a step it already finished.
 *
 * The persisted `stage`/`state` on `OutwardLoad` are the source of truth, not
 * React state: a dispatch has to survive a refresh, a different device and a
 * session that ended halfway through.
 */

/** Persisted on `OutwardLoad.stage`. Mirrors the `DispatchStage` enum. */
export type DispatchStage = "FLEET" | "MATERIALS" | "TRANSIT" | "PROOF";

/** Persisted on `OutwardLoad.state`. Mirrors the `DispatchState` enum. */
export type DispatchState = "ACTIVE" | "IN_TRANSIT" | "COMPLETED";

/** The tabs on Active Dispatch. `ALL` is a view, not a stored value. */
export type DispatchFilter = "ALL" | "ACTIVE" | "IN_TRANSIT" | "COMPLETED";

/**
 * The workflow's steps in order, as the progress rail draws them.
 *
 * Five points, and four of them are stages a person actually works in.
 * "Completed" is the consequence of finishing Proof, so its `step` is null.
 *
 * THIS array is the workflow order — not the enum's declaration order, which is
 * only the order the values happened to be added to the database.
 */
export const DISPATCH_STEPS = [
  { key: "FLEET", label: "Fleet Management", step: "FLEET" as DispatchStage },
  { key: "MATERIALS", label: "Materials", step: "MATERIALS" as DispatchStage },
  { key: "TRANSIT", label: "In Transit", step: "TRANSIT" as DispatchStage },
  { key: "PROOF", label: "Proof of Dispatch", step: "PROOF" as DispatchStage },
  { key: "COMPLETED", label: "Completed", step: null },
] as const;

export type DispatchStepKey = (typeof DISPATCH_STEPS)[number]["key"];

/** What the operator has to do next, or null when there is nothing left. */
export type NextStep = { stage: DispatchStage; label: string; href: string } | null;

/**
 * The minimum a caller has to know about a dispatch to place it in the flow.
 * Deliberately structural rather than the Prisma row, so the API, the list and
 * the detail screen can all use it without importing the client.
 */
export type DispatchProgress = {
  id: string;
  stage: DispatchStage;
  state: DispatchState;
  lineCount: number;
  /** Departure recorded and the loaded vehicle photographed — step 3 done. */
  hasTransit: boolean;
  /** Loaded weighbridge slip captured and signed off — step 4 done. */
  hasProof: boolean;
};

/**
 * In Transit is complete when the vehicle's departure is recorded AND the
 * loaded vehicle is photographed. The delivery challan is deliberately absent
 * from this check — it is optional, and a dispatch must never be held open
 * waiting for a document nobody promised.
 */
export function transitComplete(p: { dispatchedAt: unknown; filledImageUrl: unknown }): boolean {
  return !!p.dispatchedAt && !!p.filledImageUrl;
}

/**
 * Proof of Dispatch is complete when the loaded weighbridge slip is attached
 * and the step is attributed to the user who signed it off. Those are the only
 * two things step 4 asks for, so they are exactly what completes it.
 */
export function proofComplete(p: { loadedSlipUrl: unknown; proofById: unknown }): boolean {
  return !!p.loadedSlipUrl && !!p.proofById;
}

/**
 * Which step a dispatch is ON — i.e. the one that still needs doing.
 *
 * Read from what the dispatch actually HAS, not only from the stored stage, so
 * a record that was interrupted between a write and its stage bump still lands
 * on the right screen. The stage is the fast path; the contents are the check.
 *
 * `state === "COMPLETED"` short-circuits FIRST and deliberately: every dispatch
 * finished under the previous three-stage workflow carries no loaded slip and
 * no proof author, and re-deriving those rows would drag finished history back
 * into the queue. What was completed stays completed.
 */
export function currentStage(d: DispatchProgress): DispatchStage | null {
  if (d.state === "COMPLETED") return null;
  if (d.lineCount === 0) return "MATERIALS";
  if (!d.hasTransit) return "TRANSIT";
  if (!d.hasProof) return "PROOF";
  return null;
}

/** Where "Continue Dispatch" goes, or null when the dispatch is finished. */
export function nextStep(d: DispatchProgress): NextStep {
  const stage = currentStage(d);
  if (!stage) return null;
  if (stage === "MATERIALS") return { stage, label: "Add materials", href: `/outward/${d.id}/materials` };
  if (stage === "TRANSIT") return { stage, label: "Mark in transit", href: `/outward/${d.id}/transit` };
  return { stage, label: "Capture proof", href: `/outward/${d.id}/proof` };
}

/** How far along the rail a dispatch has got, for the progress UI. */
export function stepStatus(d: DispatchProgress, key: DispatchStepKey): "done" | "current" | "todo" {
  const done = new Set<DispatchStepKey>();
  // Fleet is always done: the dispatch cannot exist without it.
  done.add("FLEET");
  if (d.lineCount > 0) done.add("MATERIALS");
  if (d.hasTransit) done.add("TRANSIT");
  if (d.hasProof) done.add("PROOF");
  if (d.state === "COMPLETED") {
    // A dispatch completed under the older workflow has no transit/proof flags
    // to read, but it is finished — the rail must say so rather than showing
    // history with holes in it.
    done.add("MATERIALS");
    done.add("TRANSIT");
    done.add("PROOF");
    done.add("COMPLETED");
  }
  if (done.has(key)) return "done";
  return currentStage(d) === key ? "current" : "todo";
}

/**
 * The state a dispatch should hold given what it now contains.
 *
 * ── Why loading materials is what makes it IN_TRANSIT ────────────────────────
 * A dispatch becomes IN_TRANSIT the moment its materials are committed, i.e.
 * when step 2 completes and step 3 is the outstanding work. It is NOT deferred
 * until the step-3 form is submitted: that form is the paperwork done WHILE the
 * vehicle is in transit, so waiting for it would mean a dispatch sitting on the
 * In Transit step never appeared in the In Transit tab — which is exactly the
 * defect this replaced.
 *
 * `state` therefore answers "where is this dispatch in its life", and `stage`
 * answers "which screen is outstanding". They move together but they are not
 * the same question.
 */
export function stateFor(hasMaterials: boolean, hasProof: boolean): DispatchState {
  if (hasProof) return "COMPLETED";
  if (hasMaterials) return "IN_TRANSIT";
  return "ACTIVE";
}

const STATE_LABEL: Record<DispatchState, string> = {
  ACTIVE: "Active",
  IN_TRANSIT: "In Transit",
  COMPLETED: "Completed",
};

export function stateLabel(s: DispatchState): string {
  return STATE_LABEL[s] ?? s;
}

/**
 * ── The transition guard ─────────────────────────────────────────────────────
 *
 * Enforced by the API, not only by which screen is reachable: a hand-made
 * request must not be able to jump a dispatch straight from Materials to
 * Completed. Returns null when the write is allowed, or the reason it is not.
 */
export function transitionError(
  step: "MATERIALS" | "TRANSIT" | "PROOF",
  d: { state: DispatchState; lineCount: number; hasTransit: boolean }
): string | null {
  if (d.state === "COMPLETED") return "This dispatch is already completed";
  if (step === "MATERIALS") return null;
  if (step === "TRANSIT") {
    return d.lineCount > 0 ? null : "Add the materials before marking this dispatch in transit";
  }
  // PROOF — reachable only once the vehicle is actually in transit. This is the
  // rule that stops In Transit from being skipped.
  if (!d.hasTransit) return "Complete In Transit before capturing the proof of dispatch";
  return null;
}
