// GET /api/snapshot: every 2026 race with current prices, in one response.
// Vercel keeps each answer for 15 seconds and shares it with everyone viewing, so the page
// makes one call per refresh and Kalshi sees a handful of calls per 15 seconds at most.
const { buildCatalog, refreshPrices } = require("./_lib.js");

async function loadCatalog(req) {
  // Ask our own cached /api/catalog first, so the expensive build is shared and done rarely.
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (host) {
    try {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const r = await fetch(`${proto}://${host}/api/catalog`, { headers: { accept: "application/json" } });
      if (r.ok) return await r.json();
    } catch (e) {}
  }
  return buildCatalog();
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const cat = await loadCatalog(req);
    const fresh = await refreshPrices(cat);
    const races = fresh.races.flatMap((r) => r.events.map((ev) => ({ meta: r.meta, ev })));
    res.setHeader("Cache-Control", "public, s-maxage=15, stale-while-revalidate=30");
    res.status(200).json({ at: Date.now(), catalogAt: cat.at, mode: fresh.mode, races, seats: fresh.seats || null });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e.message || e) });
  }
};
