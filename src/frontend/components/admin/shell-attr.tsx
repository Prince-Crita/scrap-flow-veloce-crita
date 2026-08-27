"use client";

import { useEffect } from "react";

/**
 * Keeps `data-shell="admin"` correct across client-side navigation.
 *
 * The attribute itself is server-rendered onto <body> by the root layout from
 * the `x-sf-shell` middleware header, so the console lays out correctly on the
 * very first paint. This component exists for the soft-navigation case: React
 * does not re-render <body> on a client-side route change, so without an explicit
 * cleanup the attribute would linger and give the phone frame `display: block`.
 *
 * It asserts on mount (harmless when the server already set it) and removes on
 * unmount.
 */
export function AdminShellAttr() {
  useEffect(() => {
    document.body.dataset.shell = "admin";
    return () => {
      delete document.body.dataset.shell;
    };
  }, []);
  return null;
}
