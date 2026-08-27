import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Poppins, JetBrains_Mono } from "next/font/google";
import "@/frontend/styles/globals.css";
import { Providers } from "@/frontend/components/providers";

const poppins = Poppins({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-disp",
  display: "swap",
});

const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["500", "700", "800"],
  variable: "--font-mono",
  display: "swap",
});

/**
 * Icons are declared EXPLICITLY, and no `/favicon.ico` exists in this project.
 *
 * That is the fix for another localhost project showing this one's icon.
 * Browsers cache the guessed `/favicon.ico` per **host**, and `localhost:3000`
 * and `localhost:3001` are the same host — the port is not part of the cache
 * key. Whichever project answered `/favicon.ico` first won the tab icon for
 * every other project on localhost.
 *
 * Naming the icon (`/icon.svg`, emitted by src/app/icon.svg) means the browser
 * follows a `<link rel="icon">` in *this document* instead of guessing, so the
 * two projects can never collide. `?v=` is a cache-buster for anyone whose
 * browser already cached the wrong icon under `localhost`.
 *
 * Do NOT add `public/favicon.ico` back. It would reinstate the host-level
 * fallback and put this project's mark on the other one again.
 */
export const metadata: Metadata = {
  title: "Scrap Flow · Veloce — Yard OS",
  description: "Mobile-first scrap dealer management for live yard operations.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Scrap Flow" },
  icons: {
    icon: [{ url: "/icon.svg?v=veloce-1", type: "image/svg+xml" }],
    shortcut: [{ url: "/icon.svg?v=veloce-1", type: "image/svg+xml" }],
    /**
     * A real PNG from `public/`, not an SVG file-convention route.
     *
     * `src/app/apple-icon.svg` was never served at all: Next's apple-icon file
     * convention accepts jpg/jpeg/png only — Apple does not support SVG touch
     * icons — so the route 404'd, and because an explicit `icons` block replaces
     * Next's generated tags there was no fallback. Serving it from `public/`
     * makes the URL exact and unambiguous.
     */
    apple: [{ url: "/apple-touch-icon.png?v=veloce-1", sizes: "180x180", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#07140d",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

/**
 * `data-shell="admin"` activates src/frontend/styles/admin.css (every rule in that file
 * is nested under it). The value comes from a request header set by the
 * middleware, so the correct shell is server-rendered on the first byte — the
 * phone-centred body layout never flashes on an admin route, and the console
 * still lays out correctly with JavaScript disabled.
 *
 * On every non-admin route the attribute is absent, which is precisely why the
 * Owner and Manager screens are byte-identical to before the admin console
 * existed: not one admin rule can match.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const shell = (await headers()).get("x-sf-shell");

  return (
    <html lang="en" className={`${poppins.variable} ${jetbrains.variable}`}>
      <body data-shell={shell === "admin" ? "admin" : undefined}>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
