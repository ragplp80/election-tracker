// Temporary (preview branch only): look at state election-results files
const OK = /(ncsbe\.gov|sos\.ca\.gov|vote\.wa\.gov|arizona\.vote|azsos\.gov|alaska\.gov|amazonaws\.com|votewa\.gov|maricopa\.gov|clarityelections\.com)$/;
module.exports = async (req, res) => {
  const u = String(req.query.u || ""); const n = +req.query.n || 3000;
  let host = ""; try { host = new URL(u).hostname; } catch (e) {}
  if (!OK.test(host)) return res.status(400).json({ error: "host not allowed", host });
  try {
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (election tracker)" }, redirect: "follow" });
    const buf = Buffer.from(await r.arrayBuffer());
    let text = buf.toString("utf8");
    if (req.query.pdf) {   // text of a PDF, page by page
      const { extractText, getDocumentProxy } = await import("unpdf");
      const doc = await getDocumentProxy(new Uint8Array(buf));
      const { text: pages } = await extractText(doc, { mergePages: false });
      text = pages.map((p, i) => `=== page ${i + 1}\n${p}`).join("\n");
    }
    const links = [...new Set((text.match(/[\w./:%?=&-]+\.(csv|txt|json|zip|xml|xlsx)(\?[\w=&]*)?/gi) || []))].slice(0, 80);
    const off = +req.query.o || 0;
    const g = req.query.g ? [...text.matchAll(new RegExp(".{0,120}(?:" + req.query.g + ").{0,160}", "g"))].slice(0, 60).map((m) => m[0]) : undefined;
    res.status(200).json({ grep: g, status: r.status, type: r.headers.get("content-type"), bytes: buf.length, final: r.url, links, head: text.slice(off, off + n) });
  } catch (e) { res.status(200).json({ error: String(e), cause: String(e.cause && (e.cause.code || e.cause.message || e.cause)) }); }
};
