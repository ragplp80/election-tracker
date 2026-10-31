// GET /api/news?q=...: recent headlines for a race, from Google News search (free, no account).
// Returns [{title, source, link, at}] newest first. Cached 5 minutes and shared across viewers.
const MAX_ITEMS = 12;

function decode(s) {
  return String(s || "")
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "").trim();
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`)); return m ? decode(m[1]) : ""; };

// Parse a Google News RSS feed into headlines.
function parseFeed(xml) {
  const items = [];
  for (const m of String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    let title = tag(it, "title"), source = tag(it, "source");
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3));   // "Headline - Source"
    const at = Date.parse(tag(it, "pubDate"));
    const link = tag(it, "link");
    if (title && Number.isFinite(at) && /^https?:\/\//.test(link)) items.push({ title, source, link, at });
  }
  items.sort((a, b) => b.at - a.at);
  const seen = new Set();
  return items.filter((i) => { const k = i.title.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, MAX_ITEMS);
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const q = String(req.query.q || "").trim();
  if (!q || q.length > 200) return res.status(400).json({ error: "q is required (200 characters max)" });
  const url = "https://news.google.com/rss/search?" + new URLSearchParams({ q: q + " when:3d", hl: "en-US", gl: "US", ceid: "US:en" });
  try {
    const r = await fetch(url, { headers: { accept: "application/rss+xml, application/xml" } });
    if (!r.ok) throw new Error("news HTTP " + r.status);
    const items = parseFeed(await r.text());
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({ q, items });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(502).json({ error: String(e.message || e) });
  }
};
module.exports.parseFeed = parseFeed;
