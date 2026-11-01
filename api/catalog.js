// GET /api/catalog: every 2026 race Kalshi lists, with markets.
// Building it takes ~250 Kalshi calls, so the server keeps a shared copy (see getCatalog in
// _lib.js) and Vercel's CDN keeps the response for an hour.
const { getCatalog } = require("./_lib.js");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const cat = await getCatalog();
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json(cat);
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e.message || e) });
  }
};
