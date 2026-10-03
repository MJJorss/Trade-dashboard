/**
 * mj-trading — static asset server plus a small price proxy.
 *
 * WHY THIS EXISTS
 * The dashboard fetched quotes straight from the browser: stooq.com first,
 * then three public CORS proxies. Every one of them fails from the deployed
 * origin — Stooq sends no Access-Control-Allow-Origin, and the public proxies
 * answer 403. So every price on every card has always rendered as "—", and a
 * single page load fired 400+ doomed requests (the console dropped over 10,000
 * error lines).
 *
 * A Worker has no same-origin policy, so it can fetch upstream directly. The
 * page now calls its own origin and the browser is never involved in a
 * cross-origin request.
 *
 * Endpoints:
 *   GET /api/prices?symbols=RELIANCE,TCS   -> { "RELIANCE": {...}, ... }
 *   GET /api/price?symbol=RELIANCE         -> { price, changePct, prev, source }
 *   GET /api/data/<file>                   -> a file from the data repo
 *   GET|POST /login, GET /logout           -> the password gate
 * Anything else falls through to the static assets.
 *
 * PASSWORD GATE
 * With the DASHBOARD_PASSWORD secret set, every page, data file and price
 * lookup needs a signed session cookie, which /login issues for 30 days.
 * Only what the browser needs to show the login screen and install the app
 * stays public (LOGIN_PUBLIC below). wrangler.jsonc sets run_worker_first so
 * static assets pass through here too; without it Cloudflare would serve
 * index.html straight from the edge and the gate would never run.
 * Without the secret the site stays open, so deploying this before the
 * secret exists cannot lock anyone out.
 *
 * DATA
 * The page used to fetch raw.githubusercontent.com itself, which only works
 * while the data repo is public. /api/data/ reads it here instead, with the
 * GITHUB_TOKEN secret when set, so the repo can be private and no browser
 * ever holds a GitHub token.
 */

/* Cloudflare caps SUBREQUESTS per Worker invocation — 50 on the free plan.
   Each symbol can cost up to three (Yahoo .NS, Yahoo .BO, then Stooq), so a
   batch of 60 can demand 180 and the whole invocation dies. Measured against
   the deployed Worker:

       10 symbols -> 200, all priced
       25 symbols -> 200, 24 priced
       40 symbols -> 200, 37 priced
       60 symbols -> 500, Cloudflare error page

   15 x 3 = 45 stays under the cap even in the worst case where every symbol
   needs every fallback. SUBREQUEST_BUDGET is a second line of defence: if the
   plan's limit is ever lower than assumed, symbols degrade to null instead of
   the entire batch failing. */
const MAX_SYMBOLS = 15;
const SUBREQUEST_BUDGET = 45;
const UPSTREAM_TIMEOUT_MS = 6000;
const EDGE_TTL = 120;          // seconds; quotes are informational, not execution
const CONCURRENCY = 6;         // be a polite client to the upstreams

// NSE tickers are letters, digits, & and - (e.g. M&M, BAJAJ-AUTO).
const SYMBOL_RE = /^[A-Za-z0-9&\-]{1,20}$/;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${EDGE_TTL}`,
      ...extraHeaders,
    },
  });
}

async function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Close of the session BEFORE the one the live price belongs to.
 *
 *  This used to read meta.chartPreviousClose, which is not the previous day's
 *  close: it is the close before the START OF THE REQUESTED RANGE. With
 *  range=5d that is roughly six sessions back, so every "day change" the
 *  dashboard showed was really a five-day change wearing a daily label.
 *
 *  Deriving it from the returned series instead is exact. Walking back to the
 *  last bar on a different exchange-day than regularMarketTime handles both
 *  states correctly: while the market is open the final bar is today's partial
 *  one, and after the close it is today's settled bar — either way the bar
 *  before it is the prior session.
 */
function priorSessionClose(result, meta) {
  const ts = result?.timestamp || [];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const n = Math.min(ts.length, closes.length);
  if (n < 2) return null;

  let fmt;
  try {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: meta?.exchangeTimezoneName || "Asia/Kolkata",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
  } catch (_) {
    return null;   // no ICU for this zone; fall back to the meta fields
  }
  const dayOf = (epochSec) => fmt.format(new Date(epochSec * 1000));

  const liveDay = typeof meta?.regularMarketTime === "number"
    ? dayOf(meta.regularMarketTime)
    : dayOf(ts[n - 1]);

  for (let i = n - 1; i >= 0; i--) {
    const c = closes[i];
    if (typeof c !== "number" || !(c > 0)) continue;
    if (dayOf(ts[i]) !== liveDay) return c;
  }
  return null;
}

/** Yahoo first: better coverage of Indian listings and it returns the previous
 *  close alongside the last price, so the day change needs no second call. */
async function fromYahoo(symbol, budget) {
  for (const suffix of [".NS", ".BO"]) {
    if (!budget.take()) return null;
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}${suffix}` +
                  `?interval=1d&range=5d`;
      const res = await withTimeout(
        (signal) => fetch(url, { signal, headers: { "User-Agent": "Mozilla/5.0" } }),
        UPSTREAM_TIMEOUT_MS
      );
      if (!res.ok) continue;
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta) continue;
      const price = meta.regularMarketPrice ?? meta.previousClose;
      if (typeof price !== "number" || !(price > 0)) continue;

      // Series first (exact), then the explicit meta field. chartPreviousClose
      // is deliberately NOT used as a last resort: it is range-relative, so
      // falling back to it would quietly reintroduce the multi-day number this
      // function exists to avoid. Returning null lets the page fall back to the
      // previous close implied by signals_today.json instead.
      let prev = priorSessionClose(result, meta);
      if (!(typeof prev === "number" && prev > 0) &&
          typeof meta.previousClose === "number" && meta.previousClose > 0) {
        prev = meta.previousClose;
      }
      if (!(typeof prev === "number" && prev > 0)) prev = null;

      const changePct = prev != null ? ((price - prev) / prev) * 100 : null;
      return { price, changePct, prev, source: `yahoo${suffix}` };
    } catch (_) { /* try the next suffix */ }
  }
  return null;
}

/** Stooq fallback. Daily CSV, oldest to newest, close is column 5. */
async function fromStooq(symbol, budget) {
  if (!budget.take()) return null;
  try {
    const url = `https://stooq.com/q/d/l/?s=${symbol.toLowerCase()}.in&i=d`;
    const res = await withTimeout((signal) => fetch(url, { signal }), UPSTREAM_TIMEOUT_MS);
    if (!res.ok) return null;
    const csv = await res.text();
    if (!csv || csv.includes("No data") || csv.includes("<")) return null;
    const rows = csv.trim().split("\n");
    if (rows.length < 3) return null;
    const price = parseFloat(rows[rows.length - 1].split(",")[4]);
    const prev = parseFloat(rows[rows.length - 2].split(",")[4]);
    if (!(price > 0)) return null;
    const changePct = prev > 0 ? ((price - prev) / prev) * 100 : null;
    return { price, changePct, prev: prev > 0 ? prev : null, source: "stooq" };
  } catch (_) {
    return null;
  }
}

/** Per-symbol edge cache, so one popular symbol is fetched once per TTL across
 *  every visitor rather than once per card render. */
async function quoteFor(symbol, ctx, budget) {
  const cacheKey = new Request(`https://cache.local/quote/${symbol}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) return await hit.json();

  const quote = (await fromYahoo(symbol, budget)) || (await fromStooq(symbol, budget));
  const payload = quote || { price: null, changePct: null, prev: null, source: null };

  // Cache misses too, briefly, so an unknown ticker cannot be retried on every
  // single render by every visitor.
  const toCache = new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json",
               "cache-control": `public, max-age=${quote ? EDGE_TTL : 60}` },
  });
  ctx.waitUntil(cache.put(cacheKey, toCache.clone()));
  return payload;
}

/** Resolve with a bounded number of upstream requests in flight. */
async function mapLimited(items, limit, fn) {
  const results = {};
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      const key = items[idx];
      results[key] = await fn(key);
    }
  });
  await Promise.all(workers);
  return results;
}

function parseSymbols(raw) {
  return [...new Set(
    (raw || "")
      .split(",")
      .map((s) => s.trim().toUpperCase().replace(/\.(NS|BO)$/i, ""))
      .filter((s) => s && SYMBOL_RE.test(s))
  )].slice(0, MAX_SYMBOLS);
}

// ─── PASSWORD GATE ──────────────────────────────────────────────────────────

const SESSION_COOKIE = "mj_session";
const SESSION_DAYS = 30;
const FAILED_LOGIN_DELAY_MS = 1200;   // slows guessing; one guess per ~1.2s per connection

// Reachable without a session: the login screen itself, and what the browser
// fetches to offer installation (manifest, icons, service worker).
const LOGIN_PUBLIC = new Set(["/login", "/logout", "/manifest.webmanifest", "/sw.js"]);
const isPublicPath = (p) => LOGIN_PUBLIC.has(p) || p.startsWith("/icons/");

const enc = new TextEncoder();

function b64url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** HMAC key derived from the password (or SESSION_SECRET if set), so changing
 *  the password signs every existing device out. */
async function sessionKey(env) {
  const secret = env.SESSION_SECRET || env.DASHBOARD_PASSWORD;
  return crypto.subtle.importKey("raw", enc.encode("mj-session:" + secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function sign(env, payload) {
  return b64url(await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(payload)));
}

/** Equal-time comparison of two strings, via fixed-length digests. */
async function sameString(a, b) {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

async function hasSession(request, env) {
  const raw = readCookie(request, SESSION_COOKIE);
  if (!raw) return false;
  const [v, exp, sig] = raw.split(".");
  if (v !== "v1" || !exp || !sig || !(Number(exp) > Date.now() / 1000)) return false;
  return sameString(sig, await sign(env, `v1.${exp}`));
}

async function sessionCookie(env, secure) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const value = `v1.${exp}.${await sign(env, `v1.${exp}`)}`;
  return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${SESSION_DAYS * 86400}; ` +
         `HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function loginPage(failed) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0f172a"><meta name="robots" content="noindex">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" href="/icons/favicon-64.png">
<title>MJ Trading · Sign in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px;
         background: radial-gradient(900px 500px at 15% -10%, rgba(99,102,241,.18), transparent 60%), #0f172a;
         color: #e2e8f0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  form { width: 100%; max-width: 360px; background: #1e293b; border: 1px solid #2b3a52;
         border-radius: 18px; padding: 28px 24px; box-shadow: 0 20px 40px rgba(2,6,23,.5); }
  .logo { width: 44px; height: 44px; border-radius: 13px; margin-bottom: 14px;
          background: linear-gradient(135deg, #4f46e5, #a78bfa); display: grid; place-items: center; }
  h1 { margin: 0; font-size: 19px; color: #fff; }
  p { margin: 4px 0 20px; color: #94a3b8; font-size: 13px; }
  label { display: block; font-size: 12px; color: #94a3b8; margin-bottom: 6px; }
  input[type=password] { width: 100%; padding: 11px 12px; border-radius: 10px; font-size: 15px;
         background: #0f172a; border: 1px solid #3b4b66; color: #fff; outline: none; }
  input[type=password]:focus { border-color: #818cf8; box-shadow: 0 0 0 3px rgba(129,140,248,.2); }
  button { width: 100%; margin-top: 16px; padding: 11px; border: 0; border-radius: 10px; cursor: pointer;
           background: #4f46e5; color: #fff; font-size: 14px; font-weight: 600; }
  button:hover { background: #6366f1; }
  .err { margin: 12px 0 0; padding: 8px 10px; border-radius: 8px; font-size: 12.5px;
         background: rgba(251,113,133,.12); color: #fb7185; border: 1px solid rgba(251,113,133,.3); }
</style></head><body>
<form method="post" action="/login">
  <div class="logo"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6"
    stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="15 7 21 7 21 13"/></svg></div>
  <h1>MJ Trading</h1>
  <p>Private dashboard. Enter the password to continue.</p>
  <input type="text" name="username" value="mj-trading" autocomplete="username" hidden>
  <label for="pw">Password</label>
  <input id="pw" type="password" name="password" autocomplete="current-password" required autofocus>
  ${failed ? '<div class="err" role="alert">Wrong password. Try again.</div>' : ""}
  <button type="submit">Sign in</button>
</form></body></html>`;
  return new Response(html, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
               "x-robots-tag": "noindex" },
  });
}

async function handleLogin(request, env, url) {
  if (request.method === "GET") return loginPage(url.searchParams.has("e"));
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

  let password = "";
  try { password = String((await request.formData()).get("password") || ""); } catch (_) {}
  if (!(await sameString(password, env.DASHBOARD_PASSWORD))) {
    await new Promise((r) => setTimeout(r, FAILED_LOGIN_DELAY_MS));
    return Response.redirect(new URL("/login?e=1", url).toString(), 303);
  }
  return new Response(null, {
    status: 303,
    headers: { location: "/", "set-cookie": await sessionCookie(env, url.protocol === "https:"),
               "cache-control": "no-store" },
  });
}

function handleLogout(url) {
  return new Response(null, {
    status: 303,
    headers: { location: "/login", "cache-control": "no-store",
               "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax` +
                             (url.protocol === "https:" ? "; Secure" : "") },
  });
}

// ─── DATA FILES ─────────────────────────────────────────────────────────────

const DATA_DEFAULTS = { owner: "MJJorss", repo: "trade-dashboard-data", branch: "main" };
// Plain relative paths to the repo's data files only: no "..", no dotfiles.
const DATA_PATH_RE = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:json|csv)$/;

async function handleData(request, env, url) {
  if (request.method !== "GET") return json({ error: "method not allowed" }, 405);
  let path = "";
  try { path = decodeURIComponent(url.pathname.slice("/api/data/".length)); } catch (_) {}
  if (!DATA_PATH_RE.test(path) || path.split("/").some((seg) => seg.startsWith("."))) {
    return json({ error: "bad path" }, 400);
  }
  const owner = env.DATA_OWNER || DATA_DEFAULTS.owner;
  const repo = env.DATA_REPO || DATA_DEFAULTS.repo;
  const branch = env.DATA_BRANCH || DATA_DEFAULTS.branch;

  // With a token: the contents API, which serves private repos and is never
  // stale. Without one: raw.githubusercontent.com, as the page used to, with
  // the page's cache-buster passed through so its CDN copy is bypassed.
  let upstream, headers = { "User-Agent": "mj-trading-worker" };
  if (env.GITHUB_TOKEN) {
    upstream = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`;
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
    headers.Accept = "application/vnd.github.raw";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
  } else {
    upstream = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}` +
               `?t=${encodeURIComponent(url.searchParams.get("t") || Date.now())}`;
  }

  let res;
  try {
    res = await withTimeout((signal) => fetch(upstream, { signal, headers }), 15000);
  } catch (_) {
    return json({ error: "upstream timeout" }, 504, { "cache-control": "no-store" });
  }
  if (!res.ok) {
    return json({ error: `upstream ${res.status}`, file: path }, res.status === 404 ? 404 : 502,
                { "cache-control": "no-store" });
  }
  return new Response(res.body, {
    status: 200,
    headers: {
      "content-type": path.endsWith(".json") ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
      "cache-control": "private, no-store",
    },
  });
}

// Policies the _headers file sets for direct edge serving, repeated here
// because with run_worker_first every asset now comes through the Worker.
function withAssetHeaders(res, pathname) {
  if (!["/", "/index.html", "/sw.js", "/manifest.webmanifest"].includes(pathname)) return res;
  const out = new Response(res.body, res);
  out.headers.set("cache-control", "no-cache, must-revalidate");
  if (pathname === "/manifest.webmanifest") out.headers.set("content-type", "application/manifest+json");
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (env.DASHBOARD_PASSWORD) {
      if (url.pathname === "/login") return handleLogin(request, env, url);
      if (url.pathname === "/logout") return handleLogout(url);
      if (!isPublicPath(url.pathname) && !(await hasSession(request, env))) {
        if (url.pathname.startsWith("/api/")) {
          return json({ error: "sign in required" }, 401, { "cache-control": "no-store" });
        }
        return loginPage(false);
      }
    } else if (url.pathname === "/login" || url.pathname === "/logout") {
      return Response.redirect(new URL("/", url).toString(), 303);
    }

    if (url.pathname.startsWith("/api/data/")) return handleData(request, env, url);

    if (url.pathname === "/api/price" || url.pathname === "/api/prices") {
      if (request.method !== "GET") {
        return json({ error: "method not allowed" }, 405);
      }

      const symbols = url.pathname === "/api/price"
        ? parseSymbols(url.searchParams.get("symbol"))
        : parseSymbols(url.searchParams.get("symbols"));

      if (!symbols.length) {
        return json({ error: "no valid symbols" }, 400);
      }

      // One budget shared by the whole invocation. A symbol that cannot be
      // funded returns null rather than taking the batch down with it.
      let spent = 0;
      const budget = { take: () => (spent < SUBREQUEST_BUDGET ? (spent++, true) : false) };

      const quotes = await mapLimited(symbols, CONCURRENCY, (s) => quoteFor(s, ctx, budget));

      if (url.pathname === "/api/price") {
        const only = quotes[symbols[0]];
        return only && only.price != null
          ? json(only)
          : json({ error: "not found", symbol: symbols[0] }, 404);
      }
      return json(quotes);
    }

    /* Everything else is the static site. With run_worker_first (see
       wrangler.jsonc) every asset request reaches this line after the gate,
       so the cache policy from _headers is applied here as well. */
    return withAssetHeaders(await env.ASSETS.fetch(request), url.pathname);
  },
};
