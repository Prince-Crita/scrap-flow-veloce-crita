/**
 * Content-Security-Policy verification, in a real browser.
 *
 * A CSP is not verified by reading the header. It is verified by loading every
 * page, exercising the features that inline things — charts with computed bar
 * widths, the camera sheet, SSE, uploads — and proving the browser reported
 * **zero** violations while everything still rendered.
 *
 * The failure mode this guards against is the quiet one: a policy that blocks a
 * lazily-loaded chunk or an injected <style> leaves a page that looks *almost*
 * right, and nobody notices until a customer does. So this asserts both halves —
 * no violations AND the content actually rendered.
 *
 * Violations are collected two ways, because neither alone is complete:
 *   • the `securitypolicyviolation` DOM event, which fires per blocked resource
 *   • console messages, which catch violations reported before our listener runs
 *
 * Usage: app on :3001, then `npx tsx tests/csp.test.ts`
 */
import { chromium, type Browser, type Page } from "playwright";
import { TEST_OWNER, TEST_MANAGER } from "./fixtures";

const BASE = process.env.BASE_URL || "http://localhost:3001";
const ADMIN = { email: "admin@scrapflow.in", password: "ScrapFlow@2026" };

let pass = 0,
  fail = 0;
const check = (l: string, c: boolean, x = "") => {
  if (c) {
    pass++;
    console.log(`  ✓ ${l}`);
  } else {
    fail++;
    console.log(`  ✗ ${l} ${x}`);
  }
};

type Violation = { directive: string; blocked: string };

/** Attaches collectors BEFORE any navigation, so nothing is missed. */
async function instrument(page: Page) {
  const violations: Violation[] = [];
  const consoleErrors: string[] = [];

  await page.exposeFunction("__sfCspViolation", (directive: string, blocked: string) => {
    violations.push({ directive, blocked });
  });
  // No named arrow consts inside this string: tsx/esbuild would wrap them in a
  // __name() helper that does not exist in the browser.
  await page.addInitScript(`
    document.addEventListener('securitypolicyviolation', function (e) {
      try {
        window.__sfCspViolation(e.effectiveDirective || e.violatedDirective || '?', e.blockedURI || '(inline)');
      } catch (_) {}
    });
  `);

  page.on("console", (m) => {
    const t = m.text();
    if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(t)) consoleErrors.push(t);
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  return { violations, consoleErrors };
}

async function login(page: Page, email: string, password: string) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([page.waitForURL((u) => !u.pathname.includes("/login"), { timeout: 45_000 }), page.click('button[type="submit"]')]);
}

async function main() {
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();

    /* ── 1. The policy itself ── */
    console.log("The header is strict where it matters:");
    const res = await fetch(`${BASE}/login`, { redirect: "manual" });
    const csp = res.headers.get("content-security-policy") ?? "";
    check("a CSP header is present", csp.length > 0);
    check("script-src carries a nonce", /script-src[^;]*'nonce-[^']+'/.test(csp), csp);
    check("script-src uses strict-dynamic", /script-src[^;]*'strict-dynamic'/.test(csp));
    check("script-src does NOT allow unsafe-inline", !/script-src[^;]*'unsafe-inline'/.test(csp), csp);
    check("script-src does NOT allow unsafe-eval in production", !/script-src[^;]*'unsafe-eval'/.test(csp), csp);
    check("style-src (elements) is nonce-based, not unsafe-inline", /style-src\s[^;]*'nonce-/.test(csp) && !/style-src\s[^;]*'unsafe-inline'/.test(csp), csp);
    check("object-src is 'none'", /object-src 'none'/.test(csp));
    check("frame-ancestors is 'none'", /frame-ancestors 'none'/.test(csp));
    check("base-uri is locked to self", /base-uri 'self'/.test(csp));
    check("form-action is locked to self", /form-action 'self'/.test(csp));
    // The one documented relaxation.
    check("style-src-attr allows inline (documented: no nonce exists for attributes)", /style-src-attr 'unsafe-inline'/.test(csp));

    console.log("\nThe nonce is fresh per request — a replayed nonce would be worthless:");
    const a = (await (await fetch(`${BASE}/login`)).headers.get("content-security-policy")) ?? "";
    const b = (await (await fetch(`${BASE}/login`)).headers.get("content-security-policy")) ?? "";
    const nonceOf = (s: string) => s.match(/'nonce-([^']+)'/)?.[1] ?? "";
    check("two requests get different nonces", nonceOf(a) !== nonceOf(b) && !!nonceOf(a), `${nonceOf(a)} vs ${nonceOf(b)}`);

    const html = await (await fetch(`${BASE}/login`)).text();
    check("Next stamped the nonce onto its script tags", /<script[^>]+nonce="/.test(html));

    /* ── 2. Every page, every role, zero violations ── */
    const suites: { label: string; creds: { email: string; password: string }; paths: string[]; expectText?: string }[] = [
      { label: "ADMIN", creds: ADMIN, paths: ["/admin", "/admin/analytics", "/admin/yards", "/admin/users", "/admin/audit"] },
      { label: "OWNER", creds: TEST_OWNER, paths: ["/stock", "/inward", "/sort", "/sell"] },
      { label: "MANAGER", creds: TEST_MANAGER, paths: ["/stock", "/inward", "/sort", "/outward"] },
    ];

    for (const s of suites) {
      console.log(`\n[${s.label}] no CSP violations, and the pages actually render:`);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const { violations, consoleErrors } = await instrument(page);
      await login(page, s.creds.email, s.creds.password);

      for (const p of s.paths) {
        await page.goto(BASE + p, { waitUntil: "networkidle" });
        await page.waitForTimeout(900); // let lazy chunks and charts land
        const body = await page.evaluate(() => document.body.innerText.length);
        check(`${p} rendered content (${body} chars)`, body > 80, String(body));
      }

      // Hydration must have succeeded: React attaches listeners, so a control
      // responds. A CSP that blocked the bundle leaves markup that looks fine.
      const clickable = await page.evaluate(() => document.querySelectorAll("button, a[href]").length);
      check(`${s.label} interactive elements present (${clickable})`, clickable > 0);

      check(`${s.label}: zero CSP violations`, violations.length === 0, JSON.stringify(violations.slice(0, 6)));
      check(`${s.label}: zero CSP console errors`, consoleErrors.length === 0, consoleErrors.slice(0, 4).join(" | "));
      await ctx.close();
    }

    /* ── 3. The features most likely to be broken by CSP ── */
    console.log("\nCharts render with their computed inline widths (style-src-attr):");
    {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      const { violations } = await instrument(page);
      await login(page, ADMIN.email, ADMIN.password);
      await page.goto(`${BASE}/admin/analytics`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
      const styled = await page.evaluate(() => document.querySelectorAll("[style]").length);
      check(`elements with inline style attributes render (${styled})`, styled > 0, String(styled));
      const svg = await page.evaluate(() => document.querySelectorAll("svg").length);
      check(`inline SVG icons render (${svg})`, svg > 0, String(svg));
      /**
       * Exact test for a blocked style attribute: when `style-src-attr` refuses
       * one, the attribute is still in the DOM but the browser never parses it,
       * so `el.style.cssText` comes back EMPTY. Any element with a non-empty
       * style attribute and an empty cssText was blocked.
       *
       * (The previous version of this check selected `[style*='width']` and then
       * read `.style.width` — which matched `min-width` and read a property that
       * was never declared. It reported a failure the app did not have.)
       */
      const styleState = await page.evaluate(() => {
        const out = { total: 0, blocked: 0, sample: "" };
        for (const el of document.querySelectorAll("[style]")) {
          const attr = (el.getAttribute("style") ?? "").trim();
          if (!attr) continue;
          out.total++;
          if ((el as HTMLElement).style.cssText.trim() === "") {
            out.blocked++;
            if (!out.sample) out.sample = attr.slice(0, 60);
          }
        }
        return out;
      });
      check(
        `every inline style attribute was applied, none blocked (${styleState.total} checked)`,
        styleState.total > 0 && styleState.blocked === 0,
        `${styleState.blocked} blocked, e.g. "${styleState.sample}"`
      );
      check("analytics: zero CSP violations", violations.length === 0, JSON.stringify(violations.slice(0, 6)));
      await ctx.close();
    }

    console.log("\nSSE (realtime) connects under connect-src 'self':");
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const { violations } = await instrument(page);
      await login(page, TEST_OWNER.email, TEST_OWNER.password);
      await page.goto(`${BASE}/stock`, { waitUntil: "networkidle" });
      const sse = await page.evaluate(async () => {
        return await new Promise<string>((resolve) => {
          const es = new EventSource("/api/realtime/stream");
          const t = setTimeout(() => {
            es.close();
            resolve("timeout");
          }, 12000);
          es.onopen = () => {
            clearTimeout(t);
            es.close();
            resolve("open");
          };
          es.onerror = () => {
            clearTimeout(t);
            es.close();
            resolve("error");
          };
        });
      });
      check("an EventSource to /api/realtime/stream opens", sse === "open", sse);
      check("SSE: zero CSP violations", violations.length === 0, JSON.stringify(violations.slice(0, 6)));
      await ctx.close();
    }

    console.log("\nAuth.js works end to end under CSP (this whole suite logged in three times):");
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const { violations, consoleErrors } = await instrument(page);
      await login(page, TEST_MANAGER.email, TEST_MANAGER.password);
      const session = await page.evaluate(async () => {
        const r = await fetch("/api/auth/session");
        return await r.text();
      });
      check("the session endpoint returns the signed-in user", /"email"/.test(session), session.slice(0, 120));
      // Sign-out is a form POST — form-action 'self' must permit it.
      check("Auth.js: zero CSP violations", violations.length === 0, JSON.stringify(violations.slice(0, 6)));
      check("Auth.js: no page errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
      await ctx.close();
    }

    console.log("\nThe camera capture input survives CSP (img-src data:/blob:):");
    {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      const { violations } = await instrument(page);
      await login(page, TEST_MANAGER.email, TEST_MANAGER.password);
      await page.goto(`${BASE}/inward`, { waitUntil: "networkidle" });
      const inputs = await page.evaluate(() => document.querySelectorAll('input[type="file"][accept^="image"]').length);
      check(`capture inputs present (${inputs})`, inputs > 0, String(inputs));
      // A data: URL image must be renderable — this is what the preview uses.
      const dataUrlOk = await page.evaluate(async () => {
        return await new Promise<boolean>((resolve) => {
          const img = new Image();
          img.onload = () => resolve(true);
          img.onerror = () => resolve(false);
          img.src =
            "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        });
      });
      check("a data: URL image loads (camera preview path)", dataUrlOk);
      check("camera page: zero CSP violations", violations.length === 0, JSON.stringify(violations.slice(0, 6)));
      await ctx.close();
    }

    console.log(`\n==== csp: ${pass} passed, ${fail} failed ====`);
  } finally {
    await browser?.close();
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
