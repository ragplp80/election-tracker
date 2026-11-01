// Temporary: list margin-of-victory series (preview branch only)
const { kget } = require("./_lib.js");
module.exports = async (req, res) => {
  const j = await kget("/series?category=Elections");
  const hits = (j.series || []).filter((s) => /margin|\bmov\b|MOV/i.test(`${s.ticker} ${s.title}`)).map((s) => `${s.ticker} | ${s.title}`);
  let open = [];
  for (const h of hits) {
    const t = h.split(" | ")[0];
    try { const e = await kget(`/events?series_ticker=${t}&status=open&with_nested_markets=true`); for (const ev of e.events || []) open.push(`${ev.event_ticker} | ${ev.title} | ${(ev.markets||[]).length} mkts | ${(ev.markets||[]).slice(0,12).map(m=>`${m.yes_sub_title||m.subtitle}=${m.last_price_dollars}`).join("; ")}`); } catch (e) {}
  }
  res.status(200).json({ total: (j.series || []).length, hits, open });
};
