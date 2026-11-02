// Temporary (preview branch only): every open Elections event, compact, for a coverage sweep
const { kget } = require("./_lib.js");
module.exports = async (req, res) => {
  const out = []; let cursor = "", pages = 0;
  do {
    const j = await kget(`/events?status=open&limit=200${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    for (const e of j.events || []) if (e.category === "Elections" || e.category === "Politics") out.push([e.event_ticker, e.series_ticker, e.title, e.sub_title || ""]);
    cursor = j.cursor || ""; pages++;
  } while (cursor && pages < 80);
  res.status(200).json({ pages, n: out.length, events: out });
};
