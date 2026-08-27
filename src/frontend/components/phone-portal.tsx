"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** How long `.sheetClosing` runs in globals.css. Keep the two in step. */
const CLOSE_MS = 180;

/**
 * Renders children into the non-scrolling `.phone` frame so overlay sheets
 * (position:absolute; inset:0) anchor to the visible frame — not the scrolled
 * page content. Fixes popups opening off-screen after scrolling.
 *
 * ── Closing animation ────────────────────────────────────────────────────────
 * Every popup in the yard app — the weight calculator, the vendor and material
 * pickers, the camera sheet, the stock-sources dialog — opens through here, and
 * each one already scales up on the way in (`dialogIn`). None of them animated
 * OUT: the owning component simply stops rendering and the dialog blinks away.
 *
 * Each owner would otherwise have to learn to stay mounted while it closes,
 * which is the same three-line change repeated across eleven working components.
 * Instead, when this portal unmounts it leaves a copy of the popup behind, plays
 * the closing animation on that, and removes it. The copy is inert — a picture,
 * not a dialog — so nothing can be typed into or tapped on it, and React never
 * sees it. One place, every popup, no owner changed.
 *
 * The clone is taken in a LAYOUT effect cleanup, which React runs while the
 * nodes are still in the document; a passive effect would be too late.
 */
export function PhonePortal({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setEl(document.getElementById("phoneFrame"));
  }, []);

  useLayoutEffect(() => {
    if (!el) return;
    return () => {
      const box = boxRef.current;
      if (!box || !box.firstElementChild) return;
      // Someone who asked for less motion gets the instant close they had.
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

      const ghost = box.cloneNode(true) as HTMLElement;
      ghost.classList.add("sheetClosing");
      ghost.setAttribute("aria-hidden", "true");
      el.appendChild(ghost);
      setTimeout(() => ghost.remove(), CLOSE_MS + 40);
    };
  }, [el]);

  if (!el) return null;
  /**
   * The wrapper exists only so the cleanup above has something to copy. It is a
   * plain static block with no styles, so it establishes no containing block and
   * the sheets inside still position against the phone frame exactly as before.
   */
  return createPortal(<div ref={boxRef}>{children}</div>, el);
}
