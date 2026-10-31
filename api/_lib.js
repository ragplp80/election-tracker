// Server helpers shared by the API functions. Files starting with "_" are not served as endpoints.
const Core = require("../core.js");

const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET a Kalshi path, retrying when Kalshi says "too many requests" or has a hiccup.
async function kget(path, { retries = 4 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const r = await fetch(KALSHI + path, { headers: { accept: "application/json" } });
      if (r.ok) return await r.json();
      lastErr = new Error("Kalshi HTTP " + r.status);
      if (r.status !== 429 && r.status < 500) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (/HTTP 4(?!29)/.test(String(e.message))) throw e;
    }
    await sleep(300 * 2 ** (attempt - 1) + Math.random() * 200);
  }
  throw lastErr;
}

// Run fn over items with at most n in flight. Failed items come back as {error}.
async function pool(items, n, fn) {
  let i = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = await fn(items[k]); } catch (e) { out[k] = { error: String(e.message || e) }; }
    }
  }));
  return out;
}

// Every 2026 race Kalshi lists, with current markets. About 250 Kalshi calls, so it is cached
// for an hour and refreshed in the background (see api/catalog.js).
async function buildCatalog() {
  const j = await kget("/series?category=Elections");
  const cands = (j.series || []).map((s) => ({ series: s.ticker, ...Core.classify(s.ticker) })).filter((c) => c.type);
  if (!cands.some((c) => c.type === "seats")) cands.push({ series: "KXDHOUSESEATS", type: "seats" });
  const checked = await pool(cands, 8, async (c) => {
    const e = await kget(`/events?series_ticker=${c.series}&status=open&with_nested_markets=true`);
    return { ...c, events: (e.events || []).filter((ev) => Core.is2026(c, ev)) };
  });
  const failed = checked.filter((c) => c && c.error).length;
  if (failed > cands.length * 0.2) throw new Error(`catalog incomplete: ${failed} of ${cands.length} lookups failed`);
  const best = new Map();
  for (const c of checked) {
    if (!c || c.error || !c.events.length) continue;
    const key = Core.seriesKey(c), prev = best.get(key);
    if (!prev || (c.pref || 0) > (prev.pref || 0)) best.set(key, c);
  }
  let seats = null;
  const races = [];
  for (const c of best.values()) {
    const meta = { series: c.series, type: c.type, st: c.st, dist: c.dist, special: c.special };
    if (c.type === "seats") { seats = Core.slimEvent(c.events[0]); continue; }
    races.push({ meta, events: c.events.map(Core.slimEvent) });
  }
  return { at: Date.now(), races, seats, failed };
}

// Fresh prices for a catalog: a few batched calls by ticker; if a batch comes back short,
// re-read each race's events instead.
async function refreshPrices(cat) {
  const all = [...cat.races.flatMap((r) => r.events), ...(cat.seats ? [cat.seats] : [])];
  const tickers = all.flatMap((ev) => ev.markets.filter((m) => m.status !== "finalized").map((m) => m.ticker));
  const chunks = [];
  for (let i = 0; i < tickers.length; i += 40) chunks.push(tickers.slice(i, i + 40));
  const res = await pool(chunks, 4, (c) => kget(`/markets?tickers=${c.join(",")}&limit=1000`));
  const fresh = new Map();
  let errs = 0;
  for (const r of res) {
    if (!r || r.error) { errs++; continue; }
    for (const m of r.markets || []) fresh.set(m.ticker, Core.slimMarket(m));
  }
  const swap = (ev) => ({ event_ticker: ev.event_ticker, markets: ev.markets.map((m) => fresh.get(m.ticker) || m) });
  if (!errs && fresh.size >= tickers.length * 0.9) {
    return { mode: "batch", races: cat.races.map((r) => ({ meta: r.meta, events: r.events.map(swap) })), seats: cat.seats && swap(cat.seats) };
  }
  // Fallback: one call per race
  const swept = await pool(cat.races, 8, async (r) => {
    const e = await kget(`/events?series_ticker=${r.meta.series}&status=open&with_nested_markets=true`);
    return { meta: r.meta, events: (e.events || []).filter((ev) => Core.is2026(r.meta, ev)).map(Core.slimEvent) };
  });
  let seats = cat.seats;
  try {
    const s = await kget(`/events?series_ticker=KXDHOUSESEATS&status=open&with_nested_markets=true`);
    const ev = (s.events || []).find((x) => /-27$/.test(x.event_ticker));
    if (ev) seats = Core.slimEvent(ev);
  } catch (e) {}
  return { mode: "sweep", races: swept.map((x, i) => (x.error ? cat.races[i] : x)), seats };
}

module.exports = { kget, pool, buildCatalog, refreshPrices, KALSHI };
