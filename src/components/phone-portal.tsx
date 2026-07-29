"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Renders children into the non-scrolling `.phone` frame so overlay sheets
 * (position:absolute; inset:0) anchor to the visible frame — not the scrolled
 * page content. Fixes popups opening off-screen after scrolling.
 */
export function PhonePortal({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(document.getElementById("phoneFrame"));
  }, []);
  if (!el) return null;
  return createPortal(children, el);
}
