// GET /api/trends: recent trend history for every race in one response (see _trends.js).
const trends = require("./_trends.js");
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const s = await trends.read();
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
    res.status(200).json({ at: Date.now(), samples: s.samples, series: s.series });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e.message || e) });
  }
};
