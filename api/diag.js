// Temporary (preview branch only): which tickers the batched price call misses
const { getCatalog, kget, pool } = require("./_lib.js");
module.exports = async (req, res) => {
  const cat = await getCatalog();
  const all = [...cat.races.flatMap((r) => r.events), ...(cat.margins || [])];
  const ms = all.flatMap((ev) => ev.markets.map((m) => ({ t: m.ticker, s: m.status, ev: ev.event_ticker })));
  const tickers = ms.filter((m) => m.s !== "finalized").map((m) => m.t);
  const chunks = []; for (let i = 0; i < tickers.length; i += 100) chunks.push(tickers.slice(i, i + 100));
  const got = new Set(); const sizes = [];
  const res2 = await pool(chunks, 4, async (c) => { const j = await kget(`/markets?tickers=${c.join(",")}&limit=1000`); sizes.push([c.length, (j.markets || []).length, !!j.cursor]); for (const m of j.markets || []) got.add(m.ticker); return 1; });
  const missing = ms.filter((m) => m.s !== "finalized" && !got.has(m.t));
  const statuses = {}; for (const m of missing) statuses[m.s] = (statuses[m.s] || 0) + 1;
  res.status(200).json({ tickers: tickers.length, got: got.size, sizes, statuses, sample: missing.slice(0, 40) });
};
