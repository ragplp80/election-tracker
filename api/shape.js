// Temporary: the shape of a JSON document (arrays cut to their first items, long strings cut)
const OK = /(sos\.ca\.gov|votewa\.gov|ncsbe\.gov|sbcounty\.gov|lavote\.gov|kernvote\.com|voteinfo\.net|rivco\.org)$/;
function shape(v, depth, keep) {
  if (depth > 9) return "…";
  if (Array.isArray(v)) return v.length ? [...v.slice(0, keep).map((x) => shape(x, depth + 1, keep)), ...(v.length > keep ? [`…(${v.length} items)`] : [])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1, keep)]));
  if (typeof v === "string" && v.length > 60) return v.slice(0, 60) + "…";
  return v;
}
module.exports = async (req, res) => {
  const u = String(req.query.u || ""); let host = ""; try { host = new URL(u).hostname; } catch (e) {}
  if (!OK.test(host)) return res.status(400).json({ error: "host not allowed", host });
  try {
    const r = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36" } });
    let j = JSON.parse(await r.text());
    for (const k of String(req.query.path || "").split(".").filter(Boolean)) j = j?.[/^\d+$/.test(k) ? +k : k];
    res.status(200).json({ status: r.status, shape: shape(j, 0, +req.query.keep || 1) });
  } catch (e) { res.status(200).json({ error: String(e) }); }
};
