// Private "My Bets" board data — GET /api/bets?k=SECRET
// Not linked from any page. Answers only when k matches the BETS_KEY setting in Vercel;
// otherwise it looks like a missing page. The positions themselves live in the BETS_POSITIONS
// setting (JSON), never in this public repo. Prices come from Kalshi's public market data.
//
// BETS_POSITIONS: [{ "t": "KXMIDTERMMOV-TXGOVR-P3", "side": "no", "n": 17.97, "cost": 9.68,
//                    "label": "TX Gov: Abbott wins by under 3", "group": "Governor" }, ...]
const crypto = require("crypto");
const { kget } = require("./_lib.js");

function keyMatches(given) {
  const want = process.env.BETS_KEY || "";
  if (want.length < 16 || typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

function readPositions() {
  try {
    const p = JSON.parse(process.env.BETS_POSITIONS || "[]");
    return Array.isArray(p) ? p.filter((x) => x && x.t && (x.side === "yes" || x.side === "no")) : [];
  } catch (e) {
    return null;
  }
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// What one contract on your side is worth right now, in dollars (0 to 1).
// Settled markets pay 1 or 0. Otherwise: the bid/ask midpoint when the spread is tight,
// else the last trade, so a thin market doesn't swing the board on one stale quote.
function sideValue(m, side) {
  if (!m) return null;
  if (m.result === "yes" || m.result === "no") return m.result === side ? 1 : 0;
  const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars);
  let yes = null;
  if (bid != null && ask != null && ask > 0 && ask - bid <= 0.1) yes = (bid + ask) / 2;
  else yes = last ?? bid ?? ask;
  if (yes == null) return null;
  return side === "yes" ? yes : 1 - yes;
}

async function fetchMarkets(tickers) {
  const out = new Map();
  for (let i = 0; i < tickers.length; i += 50) {
    const chunk = tickers.slice(i, i + 50);
    try {
      const j = await kget(`/markets?tickers=${chunk.map(encodeURIComponent).join(",")}&limit=200`);
      for (const m of j.markets || []) out.set(m.ticker, m);
    } catch (e) {}
    // Anything the batch missed (Kalshi hiccup, one odd ticker) is read on its own
    for (const t of chunk) {
      if (out.has(t)) continue;
      try { const j = await kget(`/markets/${encodeURIComponent(t)}`, { retries: 2 }); if (j.market) out.set(t, j.market); } catch (e) {}
    }
  }
  return out;
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (req.method !== "GET") return res.status(405).send("Read-only");
  if (!keyMatches(req.query.k)) return res.status(404).send("Not found");

  const positions = readPositions();
  if (positions === null) return res.status(500).json({ error: "BETS_POSITIONS is not valid JSON" });

  const markets = await fetchMarkets([...new Set(positions.map((p) => p.t))]);
  const rows = positions.map((p) => {
    const m = markets.get(p.t);
    const v = sideValue(m, p.side);
    const n = num(p.n) || 0, cost = num(p.cost) || 0;
    return {
      ticker: p.t, label: p.label || (m && m.yes_sub_title) || p.t, group: p.group || "Other",
      side: p.side, contracts: n, cost,
      price: v,                                         // your side, 0..1
      value: v == null ? null : +(v * n).toFixed(2),
      payout: +n.toFixed(2),                            // each contract pays $1 if it wins
      status: m ? m.status : "unknown", result: m && m.result ? m.result : null,
      title: m ? m.title || null : null,
      closes: m ? m.close_time || null : null,
    };
  });
  const sum = (k) => +rows.reduce((s, r) => s + (r[k] || 0), 0).toFixed(2);
  const priced = rows.filter((r) => r.value != null);
  return res.status(200).json({
    at: Date.now(), rows,
    totals: { cost: sum("cost"), value: +priced.reduce((s, r) => s + r.value, 0).toFixed(2), payout: sum("payout"), priced: priced.length, count: rows.length },
  });
}

module.exports = handler;
module.exports.sideValue = sideValue;
module.exports.keyMatches = keyMatches;
