// GET /api/snapshot: every 2026 race with current prices, in one response.
// Vercel keeps each answer for 15 seconds and shares it with everyone viewing, so the page
// makes one call per refresh and Kalshi sees a handful of calls per 15 seconds at most.
const { getCatalog, refreshPrices } = require("./_lib.js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const t0 = Date.now();
    const cat = await getCatalog();
    const t1 = Date.now();
    const fresh = await refreshPrices(cat);
    const t2 = Date.now();
    // Timings for diagnosing slow refreshes (printed by the keep-warm job)
    res.setHeader("Server-Timing", `catalog;dur=${t1 - t0}, prices;dur=${t2 - t1}`);
    res.setHeader("X-Tracker-Stats", JSON.stringify({ mode: fresh.mode, races: cat.races.length, margins: (fresh.margins || []).length, ...fresh.stats }));
    const races = fresh.races.flatMap((r) => r.events.map((ev) => ({ meta: r.meta, ev })));
    res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=30");
    res.status(200).json({ at: Date.now(), catalogAt: cat.at, mode: fresh.mode, races, seats: fresh.seats || null, margins: fresh.margins || [], coverage: cat.coverage || null });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e.message || e) });
  }
};
