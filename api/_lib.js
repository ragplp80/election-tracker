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

// Every open event in a series. Kalshi pages its answers (a multi-district series like
// KXHOUSERACE has hundreds of events), so follow the cursor to the end.
async function kgetEvents(series, { pages = 20 } = {}) {
  const out = [];
  let cursor = "";
  for (let i = 0; i < pages; i++) {
    const e = await kget(`/events?series_ticker=${series}&status=open&with_nested_markets=true&limit=200${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    out.push(...(e.events || []));
    cursor = e.cursor || "";
    if (!cursor || !(e.events || []).length) break;
  }
  return out;
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
  // Coverage check: race-like series we don't recognize (listed in ?check so new formats get noticed)
  const untracked = (j.series || []).filter((s) => Core.untrackedRace(s.ticker, s.title)).map((s) => [s.ticker, s.title]);
  if (!cands.some((c) => c.type === "seats")) cands.push({ series: "KXDHOUSESEATS", type: "seats" });
  const look = async (c) => {
    const events = await kgetEvents(c.series);
    return { ...c, events: events.filter((ev) => Core.is2026(c, ev)) };
  };
  const checked = await pool(cands, 5, look);
  // Kalshi sometimes pushes back on a burst of requests. Retry those slowly before giving up.
  for (let pass = 0; pass < 2; pass++) {
    const redo = checked.map((c, i) => (c && c.error ? i : -1)).filter((i) => i >= 0);
    if (!redo.length) break;
    await sleep(1500);
    const again = await pool(redo.map((i) => cands[i]), 2, look);
    redo.forEach((i, k) => { checked[i] = again[k]; });
  }
  // Never publish a list that is missing a Senate, governor or control race: a short list would
  // stay cached and make races (and the seat counts built from them) vanish. Keep the last good one.
  const failed = cands.filter((c, i) => checked[i] && checked[i].error).map((c) => c.series);
  const critical = failed.filter((t) => { const c = Core.classify(t); return c && c.type !== "house"; });
  if (critical.length || failed.length > cands.length * 0.03)
    throw new Error(`catalog incomplete: ${failed.length} lookups failed (${failed.slice(0, 8).join(", ")})`);
  // Every open 2026 event is a candidate for a seat. For each seat keep the busiest one: the most
  // contracts traded wins, whichever series it's in. Events that don't match a seat are ignored.
  const best = new Map();
  for (const c of checked) {
    if (!c || c.error) continue;
    for (const ev of c.events) {
      const m = Core.eventMeta(c, ev);
      if (!m || !Core.isSeat(m)) continue;
      const key = Core.seatKey(m), vol = Core.eventVolume(ev), prev = best.get(key);
      if (!prev || vol > prev.vol || (vol === prev.vol && (m.pref || 0) > (prev.meta.pref || 0))) best.set(key, { meta: m, ev, vol });
    }
  }
  let seats = null;
  const races = [];
  for (const { meta: c, ev } of best.values()) {
    const meta = { series: c.series, type: c.type, st: c.st, dist: c.dist, special: c.special, ...(c.multi ? { multi: true } : {}) };
    if (c.type === "seats") { seats = Core.slimEvent(ev); continue; }
    races.push({ meta, events: [Core.slimEvent(ev)] });
  }
  const margins = await marginEvents();
  return { at: Date.now(), races, seats, margins, failed: failed.length, missed: failed, coverage: coverageOf(races, untracked) };
}

// Margin-of-victory markets for statewide races, used by the "How We Looking" page:
// KXGENERALMOV-SENATEGA-26 (brackets like "Jon Ossoff, 8-10%") and, for Nebraska, KXMIDTERMMOV
// ladders ("Ricketts, 5+ pts"). Missing ones just leave a race without a margin.
const MARGIN_EVENT = /^KXGENERALMOV-(SENATE|GOVPARTY)[A-Z]{2}S?-26$|^KXMIDTERMMOV-[A-Z]{2}SEN/;
async function marginEvents() {
  const out = [];
  for (const series of ["KXGENERALMOV", "KXMIDTERMMOV"]) {
    try {
      for (const ev of await kgetEvents(series)) if (MARGIN_EVENT.test(ev.event_ticker)) out.push(Core.slimEvent(ev));
    } catch (err) {}
  }
  return out;
}

// Which seats have a market, and which don't (shown in the ?check report and on the House card)
function coverageOf(races, untracked) {
  const have = new Set(races.map((r) => Core.seatKey(r.meta)));
  const S = Core.SEATS2026, houseKeys = [];
  for (const [st, n] of Object.entries(S.house)) for (let d = n === 1 ? 0 : 1; d <= (n === 1 ? 0 : n); d++) houseKeys.push(`${st}-${d}`);
  const part = (keys, prefix) => { const missing = keys.filter((k) => !have.has(`${prefix}-${k}`)); return { up: keys.length, withMarket: keys.length - missing.length, missing }; };
  return { senate: part(S.senate, "senate"), gov: part(S.gov, "gov"), house: part(houseKeys, "house"), untracked };
}

// The race list, shared between requests. Building it takes ~250 Kalshi calls (30-90 seconds), so
// it is kept in three places, fastest first: this instance's memory, Vercel's Runtime Cache (shared
// by every function in the region, kept for a day), and finally a fresh build. A copy older than an
// hour is still used, and a rebuild starts in the background, so a viewer waits for a build only
// when nothing has been kept at all.
let vercelFns = null;
try { vercelFns = require("@vercel/functions"); } catch (e) {}   // not installed when testing locally
const CATALOG_KEY = "catalog-v3", FRESH_MS = 3600e3;
let memCatalog = null, rebuilding = null;
function runtimeCache() {
  try { return vercelFns && process.env.VERCEL ? vercelFns.getCache() : null; } catch (e) { return null; }
}
function rebuildCatalog() {
  if (!rebuilding) {
    rebuilding = buildCatalog().then(async (cat) => {
      memCatalog = cat;
      try { await runtimeCache()?.set(CATALOG_KEY, cat, { ttl: 86400, name: "race list" }); } catch (e) {}
      return cat;
    }).finally(() => { rebuilding = null; });
  }
  return rebuilding;
}
async function getCatalog({ maxAge = FRESH_MS } = {}) {
  if (!memCatalog) {
    try { memCatalog = (await runtimeCache()?.get(CATALOG_KEY)) || null; } catch (e) {}
  }
  if (!memCatalog) return rebuildCatalog();
  if (Date.now() - memCatalog.at > maxAge) {
    const job = rebuildCatalog().catch(() => {});
    try { vercelFns?.waitUntil?.(job); } catch (e) {}   // let the rebuild finish after the response
  }
  return memCatalog;
}
function resetCatalogCache() { memCatalog = null; rebuilding = null; }

// Fresh prices for a catalog: a few batched calls by ticker. Races the batch didn't fully cover
// (Kalshi had a hiccup, or a market closed) are re-read one series at a time; the rest keep the
// batched prices, so one short batch no longer means re-reading every race.
async function refreshPrices(cat, { chunk = 100 } = {}) {
  const margins = cat.margins || [];
  const all = [...cat.races.flatMap((r) => r.events), ...(cat.seats ? [cat.seats] : []), ...margins];
  const tickers = all.flatMap((ev) => ev.markets.filter((m) => m.status !== "finalized").map((m) => m.ticker));
  const chunks = [];
  for (let i = 0; i < tickers.length; i += chunk) chunks.push(tickers.slice(i, i + chunk));
  const batch = (c) => kget(`/markets?tickers=${c.join(",")}&limit=1000`);
  const res = await pool(chunks, 4, batch);
  // A batch Kalshi refused (too busy, or one bad ticker spoils the lot) is split in halves and
  // retried one at a time, down to small pieces, before those races are re-read series by series.
  const split = async (c) => {
    try { return (await batch(c)).markets || []; }
    catch (e) {
      if (c.length <= 6) return [];
      const half = Math.ceil(c.length / 2);
      return [...(await split(c.slice(0, half))), ...(await split(c.slice(half)))];
    }
  };
  for (let i = 0; i < res.length; i++) {
    if (res[i] && res[i].error) res[i] = { markets: await split(chunks[i]) };
  }
  const fresh = new Map();
  for (const r of res) {
    if (!r || r.error) continue;
    for (const m of r.markets || []) fresh.set(m.ticker, Core.slimMarket(m));
  }
  const swap = (ev) => ({ event_ticker: ev.event_ticker, markets: ev.markets.map((m) => fresh.get(m.ticker) || m) });
  const covered = (ev) => ev.markets.every((m) => m.status === "finalized" || fresh.has(m.ticker));
  const short = cat.races.filter((r) => !r.events.every(covered));
  const stats = { tickers: tickers.length, calls: chunks.length, swept: short.length };
  if (!short.length) {
    return { mode: "batch", stats, races: cat.races.map((r) => ({ meta: r.meta, events: r.events.map(swap) })), seats: cat.seats && swap(cat.seats), margins: margins.map(swap) };
  }
  // Re-read the races the batch missed, one call per series (a multi-district series is read once
  // and split by event)
  const bySeries = new Map();
  const read = (series) => {
    if (!bySeries.has(series)) bySeries.set(series, kgetEvents(series).then((events) => ({ events })));
    return bySeries.get(series);
  };
  const shortSet = new Set(short);
  const swept = await pool(cat.races, 8, async (r) => {
    if (!shortSet.has(r)) return { meta: r.meta, events: r.events.map(swap) };
    const e = await read(r.meta.series);
    const mine = new Set(r.events.map((ev) => ev.event_ticker));
    const evs = (e.events || []).filter((ev) => mine.has(ev.event_ticker));   // the seat's own event only
    return { meta: r.meta, events: evs.map(Core.slimEvent) };
  });
  let seats = cat.seats && swap(cat.seats);
  if (cat.seats && !covered(cat.seats)) {
    try {
      const s = await kget(`/events?series_ticker=KXDHOUSESEATS&status=open&with_nested_markets=true`);
      const ev = (s.events || []).find((x) => /-27$/.test(x.event_ticker));
      if (ev) seats = Core.slimEvent(ev);
    } catch (e) {}
  }
  stats.series = bySeries.size;
  return { mode: "sweep", stats, races: swept.map((x, i) => (x.error ? cat.races[i] : x)), seats, margins: margins.map(swap) };
}

module.exports = { runtimeCache, kget, kgetEvents, pool, buildCatalog, getCatalog, resetCatalogCache, refreshPrices, coverageOf, KALSHI };
