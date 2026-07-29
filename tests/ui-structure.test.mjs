/**
 * Exit gate: UI structure and CSS isolation.
 *
 * The single most important invariant in this codebase is that the admin
 * console's CSS cannot reach the Owner/Manager phone UI. Every rule in
 * src/styles/admin.css is nested under `body[data-shell="admin"]`, and this
 * suite proves that attribute is present on admin routes and absent everywhere
 * else — plus that each shell renders its own structure and not the other's.
 *
 * Also checks the responsive contract statically: that wide content is wrapped
 * in an overflow container rather than allowed to widen the page.
 *
 * READ-ONLY: GETs only. Safe against Yard 1.
 *
 * Usage: start the app, then `npm run test:ui`.
 */
import { readFileSync } from "node:fs";

const BASE = process.env.BASE_URL || "http://localhost:3001";

const ADMIN = {
  email: process.env.ADMIN_EMAIL || "admin@scrapflow.in",
  password: process.env.ADMIN_PASSWORD || "ScrapFlow@2026",
};
const OWNER = { email: "owner@veloce.in", password: "owner123" };
const MANAGER = { email: "manager@veloce.in", password: "manager123" };

let pass = 0,
  fail = 0;
const check = (l, c, x = "") => {
  if (c) {
    pass++;
    console.log(`  ✓ ${l}`);
  } else {
    fail++;
    console.log(`  ✗ ${l} ${x}`);
  }
};

function client() {
  let cookies = {};
  const ch = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
  const store = (r) => {
    const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of raw) {
      const [p] = c.split(";");
      const i = p.indexOf("=");
      cookies[p.slice(0, i)] = p.slice(i + 1);
    }
  };
  const req = async (p, o = {}) => {
    const r = await fetch(BASE + p, { ...o, headers: { ...(o.headers || {}), cookie: ch() }, redirect: "manual" });
    store(r);
    return r;
  };
  const login = async (email, password) => {
    cookies = {};
    const { csrfToken } = await (await req("/api/auth/csrf")).json();
    const body = new URLSearchParams({ csrfToken, email, password, callbackUrl: BASE + "/", json: "true" });
    await req("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  };
  return { req, login };
}

/**
 * Inspect the real <body> tag, not the whole document: React also serialises
 * layout props into the inlined RSC payload, so a substring search for
 * "data-shell" over the full HTML gives false positives.
 */
const bodyTag = (html) => /<body[^>]*>/i.exec(html)?.[0] ?? "";
const isAdminShell = (html) => /data-shell=["']?admin/i.test(bodyTag(html));

const YARD_PAGES = ["/stock", "/inward", "/sort", "/sell"];
const ADMIN_PAGES = ["/admin", "/admin/analytics", "/admin/yards", "/admin/users", "/admin/audit"];

async function main() {
  /* ══════════ CSS isolation, statically ══════════ */
  console.log("\n[admin.css] every rule is shell-scoped");
  const css = readFileSync("src/styles/admin.css", "utf8");

  // Brace-depth tracking, because a naive line scan also matches keyframe steps
  // (`from {`, `50% {`) and rules nested inside @media — neither of which is a
  // top-level selector. Only depth 0 counts, and @-blocks are skipped whole.
  const topLevel = [];
  {
    let depth = 0;
    const lines = css.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      const opens = (line.match(/\{/g) ?? []).length;
      const closes = (line.match(/\}/g) ?? []).length;
      if (depth === 0 && /^[.#a-zA-Z][^{}]*\{\s*$/.test(line)) topLevel.push({ line, no: i + 1 });
      depth += opens - closes;
      if (depth < 0) depth = 0;
    }
  }
  const unscoped = topLevel.filter((l) => !l.line.startsWith('body[data-shell="admin"]'));
  // `.impBanner` is intentionally unscoped: it renders INSIDE the phone frame
  // for an impersonating admin, so it must not require the admin shell.
  const unexpected = unscoped.filter((l) => !l.line.startsWith(".impBanner"));
  check(
    "no unexpected unscoped selectors in admin.css",
    unexpected.length === 0,
    unexpected.map((l) => `${l.no}: ${l.line}`).join(" | ")
  );
  check("the intentional .impBanner block is present", unscoped.some((l) => l.line.startsWith(".impBanner")));

  console.log("\n[admin.css] responsive breakpoints exist");
  for (const bp of ["1500px", "1100px", "1000px", "560px"]) {
    check(`breakpoint ${bp} defined`, css.includes(bp));
  }
  check("horizontal overflow is contained on the body", css.includes("overflow-x: hidden"));
  check("tables scroll inside their own container", css.includes(".aTableWrap") && css.includes("overflow-x: auto"));

  /* ══════════ Owner: phone UI untouched ══════════ */
  console.log("\n[Owner · Yard 1] phone UI structure is unchanged");
  const O = client();
  await O.login(OWNER.email, OWNER.password);
  for (const path of YARD_PAGES) {
    const res = await O.req(path);
    const html = await res.text();
    check(`${path} renders 200`, res.status === 200, `got ${res.status}`);
    check(`${path} has the phone frame`, html.includes('class="phone"') && html.includes('id="phoneFrame"'));
    check(`${path} has the hazard strip`, html.includes('class="hazard"'));
    check(`${path} has the tab bar`, html.includes('class="tabbar"'));
    check(`${path} body has NO admin shell attribute`, !isAdminShell(html), bodyTag(html));
    check(`${path} has NO admin sidebar`, !html.includes("aShell") && !html.includes("aSide"));
    check(`${path} has NO impersonation banner`, !html.includes("impBanner"));
  }

  const ownerStock = await (await O.req("/stock")).text();
  for (const t of ["STOCK", "INWARD", "SORT", "SELL"]) check(`owner sees the ${t} tab`, ownerStock.includes(t));

  /* ══════════ Manager: SELL stays hidden ══════════ */
  console.log("\n[Manager · Yard 1] Sell stays hidden");
  const M = client();
  await M.login(MANAGER.email, MANAGER.password);
  const mgr = await M.req("/stock");
  const mgrHtml = await mgr.text();
  check("manager /stock renders 200", mgr.status === 200, `got ${mgr.status}`);
  check("manager has the phone frame", mgrHtml.includes('id="phoneFrame"'));
  check("manager body has NO admin shell attribute", !isAdminShell(mgrHtml));
  for (const t of ["STOCK", "INWARD", "SORT"]) check(`manager sees the ${t} tab`, mgrHtml.includes(t));
  check("manager does NOT see the SELL tab", !mgrHtml.includes(">SELL<") && !/ico">🚚/.test(mgrHtml));
  const mgrSell = await M.req("/sell");
  check("manager redirected away from /sell", mgrSell.status === 307 || mgrSell.status === 302, `got ${mgrSell.status}`);

  /* ══════════ Admin: desktop console ══════════ */
  console.log("\n[Admin] desktop console on every page, never a phone frame");
  const A = client();
  await A.login(ADMIN.email, ADMIN.password);
  for (const path of ADMIN_PAGES) {
    const res = await A.req(path);
    const html = await res.text();
    check(`${path} renders 200`, res.status === 200, `got ${res.status}`);
    check(`${path} body sets data-shell="admin"`, isAdminShell(html), bodyTag(html));
    check(`${path} has the admin shell`, html.includes("aShell") && html.includes("aSide"));
    check(`${path} has NO phone frame`, !html.includes('id="phoneFrame"'));
    check(`${path} has the grouped sidebar nav`, html.includes("aNavGroup"));
  }

  console.log("\n[Admin] yard screens redirect to the console until a yard is entered");
  for (const path of YARD_PAGES) {
    const res = await A.req(path);
    check(`${path} redirects admin to the console`, res.status === 307 || res.status === 302, `got ${res.status}`);
  }

  /* ══════════ Login + change-password shells ══════════ */
  console.log("\n[Auth pages] neither shell leaks in");
  // NOTE: /login is a client component behind a Suspense boundary, so its server
  // HTML is the `<div class="login">` fallback and the form hydrates client-side.
  // That is pre-existing behaviour — assert the shell, not the form.
  const login = await fetch(BASE + "/login");
  const loginHtml = await login.text();
  check("/login renders 200", login.status === 200);
  check("/login renders the login shell", loginHtml.includes('class="login"'));
  check("/login body has NO admin shell attribute", !isAdminShell(loginHtml), bodyTag(loginHtml));
  check("/login has NO phone frame", !loginHtml.includes('id="phoneFrame"'));

  /* ══════════ Responsive containment, per page ══════════ */
  console.log("\n[Responsive] wide content is wrapped, not allowed to widen the page");
  for (const path of ADMIN_PAGES) {
    const html = await (await A.req(path)).text();
    const tables = (html.match(/<table/g) ?? []).length;
    const wraps = (html.match(/aTableWrap/g) ?? []).length;
    // Every rendered table must sit inside a scroll container.
    check(
      `${path}: ${tables} table(s) all inside aTableWrap`,
      tables === 0 || wraps >= tables,
      `${tables} tables vs ${wraps} wrappers`
    );
    check(`${path} declares no fixed pixel width on the shell`, !/\.aShell[^}]*width:\s*\d+px/.test(html));
  }

  console.log("\n[Viewport] the phone UI keeps its viewport meta");
  const stockHtml = await (await O.req("/stock")).text();
  check("viewport meta present", /<meta name="viewport"/.test(stockHtml));
  check("viewport is device-width", /width=device-width/.test(stockHtml));

  console.log(`\n==== ui structure: ${pass} passed, ${fail} failed ====`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
