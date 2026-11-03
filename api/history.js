// GET /api/history?series=SENATETX&ticker=SENATETX-26-D&period=1|60|1440&start=<unix s>&end=<unix s>
// Price history for one market, answered from a shared store. Candles already fetched are kept
// (in Vercel's Runtime Cache, shared by every viewer and device), so each request only asks Kalshi
// for what's new since the last one: the history before that is never fetched twice.
// Same answer shape as Kalshi's candlesticks endpoint, so the page reads either.
const { kget, runtimeCache } = require("./_lib.js");

const KEEP = { 1: 3 * 86400, 60: 60 * 86400, 1440: 3 * 365 * 86400 };   // how far back each resolution is kept
const SAFE = /^[A-Z0-9][A-Z0-9.\-]{0,80}$/i;
const mem = new Map();                                                  // this instance's copy (and the store in tests)

async function load(key) {
  if (mem.has(key)) return mem.get(key);
  try { const v = await runtimeCache()?.get(key); if (v) { mem.set(key, v); return v; } } catch (e) {}
  return null;
}
async function save(key, v) {
  mem.set(key, v);
  try { await runtimeCache()?.set(key, v, { ttl: 7 * 86400, name: "price history" }); } catch (e) {}
}
// Compact candle: [end_ts, close, previous, bid close, ask close]
const pack = (c) => [c.end_period_ts, c.price?.close_dollars ?? null, c.price?.previous_dollars ?? null, c.yes_bid?.close_dollars ?? null, c.yes_ask?.close_dollars ?? null];
const unpack = ([t, close, prev, bid, ask]) => ({ end_period_ts: t, price: { close_dollars: close, previous_dollars: prev }, yes_bid: { close_dollars: bid }, yes_ask: { close_dollars: ask } });

async function history(series, ticker, period, start, end) {
  const step = period * 60, now = Math.floor(Date.now() / 1000);
  end = Math.min(end, now);
  const key = `hist-v1:${ticker}:${period}`;
  let h = await load(key);
  let fetchFrom;
  if (h && h.from <= start) {
    if (h.upTo >= end) return { h, fetched: 0 };
    fetchFrom = h.upTo - 2 * step;                 // the last candle may have been half-finished
  } else {
    fetchFrom = start;                             // nothing stored this far back: fetch the whole range
  }
  const j = await kget(`/series/${series}/markets/${ticker}/candlesticks?start_ts=${fetchFrom}&end_ts=${end}&period_interval=${period}`);
  const byT = new Map((h ? h.c : []).map((c) => [c[0], c]));
  for (const c of j.candlesticks || []) byT.set(c.end_period_ts, pack(c));   // new candles win
  const floor = now - KEEP[period];
  const c = [...byT.values()].filter((x) => x[0] >= floor).sort((a, b) => a[0] - b[0]);
  h = { from: Math.max(floor, Math.min(h && h.from <= start ? h.from : fetchFrom, fetchFrom)), upTo: end, c };
  await save(key, h);
  return { h, fetched: (j.candlesticks || []).length };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const q = req.query || {};
  const series = String(q.series || ""), ticker = String(q.ticker || ""), period = +q.period;
  const now = Math.floor(Date.now() / 1000);
  const end = Math.min(+q.end || now, now), start = +q.start;
  if (!SAFE.test(series) || !SAFE.test(ticker) || !KEEP[period] || !Number.isFinite(start) || start >= end || now - start > KEEP[period] + 86400) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "bad request" });
  }
  try {
    const { h, fetched } = await history(series, ticker, period, start, end);
    res.setHeader("Cache-Control", "public, s-maxage=20, stale-while-revalidate=60");
    res.setHeader("X-History", `stored=${h.c.length} fetched=${fetched}`);
    res.status(200).json({ candlesticks: h.c.filter((c) => c[0] >= start && c[0] <= end).map(unpack) });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e.message || e) });
  }
};
module.exports.reset = () => mem.clear();
module.exports.history = history;
