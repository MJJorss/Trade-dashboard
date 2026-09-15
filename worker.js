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
 * Anything else falls through to the static assets.
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

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

    /* Everything else is the static site.
       Note this handler is NOT what serves index.html in practice: Cloudflare
       serves matching static assets directly from the edge without invoking
       the Worker. That is why the HTML cache policy lives in the _headers
       file rather than being set here — headers set on this response would
       never reach a request the Worker never sees. */
    return env.ASSETS.fetch(request);
  },
};
