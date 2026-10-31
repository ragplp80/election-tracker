// GET /api/catalog: every 2026 race Kalshi lists, with markets.
// Building it takes ~250 Kalshi calls, so Vercel keeps a copy for an hour and, after that,
// keeps serving the old copy while it rebuilds in the background. Viewers never wait for it
// except on the very first build.
const { buildCatalog } = require("./_lib.js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const cat = await buildCatalog();
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json(cat);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e.message || e) });
  }
};
