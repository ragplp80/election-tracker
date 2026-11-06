// GET /api/votes: current vote counts and the record of vote drops for the last uncalled races
// (see _votes.js). Shared for a minute, so frequent refreshes don't hit the states' sites.
const votes = require("./_votes.js");
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const races = await votes.check();
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=60");
    res.status(200).json({ at: Date.now(), races });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e.message || e) });
  }
};
