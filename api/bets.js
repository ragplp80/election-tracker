// Private "My Bets" board data — GET /api/bets?k=SECRET
// Not linked from any page. Answers only when k matches the BETS_KEY setting in Vercel;
// otherwise it looks like a missing page. Prices come from Kalshi's public market data.
//
// Positions: when KALSHI_KEY_ID and KALSHI_PRIVATE_KEY are set in Vercel, they are read live from
// the Kalshi account (signed, read-only GET /portfolio/positions). The BETS_POSITIONS setting is
// the backup: it supplies friendly labels and known costs, and the whole list if Kalshi can't be
// reached. None of these settings are ever in this public repo or sent to the page.
//
// BETS_POSITIONS: [{ "t": "KXMIDTERMMOV-TXGOVR-P3", "side": "no", "n": 17.97, "cost": 9.68,
//                    "label": "TX Gov: Abbott wins by under 3", "group": "Governor" }, ...]
const crypto = require("crypto");
const { kget } = require("./_lib.js");

const KALSHI_HOST = "https://api.elections.kalshi.com";
const API_PREFIX = "/trade-api/v2";

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

// ---------- Live positions from the Kalshi account ----------

// Accept the private key however it was pasted into Vercel: real newlines, "\n" escapes,
// or the whole PEM squashed onto one line with spaces.
function loadPrivateKey(raw) {
  let pem = String(raw || "").trim().replace(/\\n/g, "\n").replace(/^["']|["']$/g, "");
  if (!pem) return null;
  const m = pem.match(/-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/);
  const tries = [];
  if (m) {
    const body = m[2].replace(/\s+/g, "");
    tries.push(`-----BEGIN ${m[1]}-----\n${body.match(/.{1,64}/g).join("\n")}\n-----END ${m[1]}-----\n`);
  } else {
    const body = pem.replace(/\s+/g, "");
    for (const kind of ["PRIVATE KEY", "RSA PRIVATE KEY"])
      tries.push(`-----BEGIN ${kind}-----\n${(body.match(/.{1,64}/g) || []).join("\n")}\n-----END ${kind}-----\n`);
  }
  for (const t of tries) { try { return crypto.createPrivateKey(t); } catch (e) {} }
  throw new Error("KALSHI_PRIVATE_KEY could not be read as a private key (" + describeKeyText(pem) + ")");
}

// A safe description of what was pasted, for fixing setup: length and PEM labels only, never content.
function describeKeyText(pem) {
  const labels = [...pem.matchAll(/-----(BEGIN|END) ([A-Z ]+)-----/g)].map((m) => m[1] + " " + m[2]);
  const hints = [];
  if (/PUBLIC KEY/.test(labels.join())) hints.push("this is the public key, not the private one");
  if (/ENCRYPTED/.test(labels.join()) || /Proc-Type: 4,ENCRYPTED/.test(pem)) hints.push("key is password-protected");
  if (!labels.length && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(pem)) hints.push("looks like a Key ID, not a private key");
  if (labels.length === 1) hints.push("only one of the BEGIN/END lines is present, so the key looks cut off");
  return `${pem.length} characters; labels: ${labels.length ? labels.join(", ") : "none"}${hints.length ? "; " + hints.join("; ") : ""}`;
}

// Kalshi signs timestamp + method + path (path from /trade-api/v2, without the query string).
function signRequest(key, ts, method, path) {
  const msg = Buffer.from(String(ts) + method + path.split("?")[0]);
  const sig = key.asymmetricKeyType === "rsa" || key.asymmetricKeyType === "rsa-pss"
    ? crypto.sign("sha256", msg, { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST })
    : crypto.sign(null, msg, key);   // Ed25519
  return sig.toString("base64");
}

// Kalshi serves account calls on its newer host too; try each, and keep Kalshi's reason on failure.
const ACCOUNT_HOSTS = [KALSHI_HOST, "https://external-api.kalshi.com"];

async function signedGet(keyId, key, path) {
  const reasons = [];
  for (const host of ACCOUNT_HOSTS) {
    const ts = Date.now();
    let r;
    try {
      r = await fetch(host + API_PREFIX + path, {
        headers: {
          accept: "application/json",
          "KALSHI-ACCESS-KEY": keyId,
          "KALSHI-ACCESS-TIMESTAMP": String(ts),
          "KALSHI-ACCESS-SIGNATURE": signRequest(key, ts, "GET", API_PREFIX + path),
        },
      });
    } catch (e) { reasons.push(new URL(host).hostname + ": unreachable"); continue; }
    if (r.ok) return r.json();
    let why = "";
    try { const b = await r.json(); const e = b.error || b; why = [e.code, e.message, e.details].filter(Boolean).join(" ").slice(0, 120); } catch (e) {}
    reasons.push(`${new URL(host).hostname}: HTTP ${r.status}${why ? " " + why : ""}`);
    if (r.status !== 401 && r.status !== 403 && r.status !== 404) break;
  }
  const idShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(keyId)
    ? "Key ID looks right" : `Key ID is ${keyId.length} characters and isn't in Kalshi's ID format (8-4-4-4-12)`;
  throw new Error("Kalshi account " + reasons.join("; ") + " (" + idShape + ")");
}

const dollars = (m, name) => {
  const d = num(m[name + "_dollars"]);
  if (d != null) return d;
  const c = num(m[name]);
  return c == null ? null : c / 100;
};

// Every open position on the account: [{ t, side, n, cost }]
async function accountPositions() {
  // Tolerate quotes, brackets or a label pasted around the ID: use the ID itself if it's in there
  const rawId = (process.env.KALSHI_KEY_ID || "").trim();
  const found = rawId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  const keyId = found ? found[0] : rawId.replace(/^["'\[\(<\s]+|["'\]\)>\s]+$/g, "");
  if (!keyId || !process.env.KALSHI_PRIVATE_KEY) return null;
  const key = loadPrivateKey(process.env.KALSHI_PRIVATE_KEY);
  const out = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const j = await signedGet(keyId, key, `/portfolio/positions?limit=200&count_filter=position${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    for (const m of j.market_positions || []) {
      const pos = num(m.position_fp) ?? num(m.position);
      if (!m.ticker || !pos) continue;
      out.push({ t: m.ticker, side: pos > 0 ? "yes" : "no", n: Math.abs(pos), cost: dollars(m, "market_exposure") });
    }
    cursor = j.cursor || "";
    if (!cursor || !(j.market_positions || []).length) break;
  }
  return out;
}

// Race type from the ticker, for positions that aren't in the saved list
function groupOf(t) {
  if (/^KXMVE/.test(t)) return "Parlay";
  if (/^(KXDHOUSESEATS|KXDSENATESEATS|CONTROL|KXCONTROL)/.test(t)) return "Control";
  if (/^(SENATE|KXSENATE)/.test(t) || /^KXMIDTERMMOV-[A-Z]{2}SEN/.test(t)) return "Senate";
  if (/^(GOVPARTY|KXGOV)/.test(t) || /^KXMIDTERMMOV-[A-Z]{2}GOV/.test(t)) return "Governor";
  if (/^(KXHOUSERACE|HOUSE)/.test(t) || /^KXMIDTERMMOV-[A-Z]{2}\d/.test(t)) return "House";
  if (/^KXSTATELEG/.test(t)) return "State";
  return "Other";
}

// Live account positions, with labels (and, when the holding hasn't changed, the known cost)
// taken from the saved list. Anything new on the account gets a label from Kalshi's market name.
function mergePositions(live, saved) {
  const byTicker = new Map((saved || []).map((p) => [p.t, p]));
  return live.map((p) => {
    const s = byTicker.get(p.t);
    const same = s && s.side === p.side && Math.abs((num(s.n) || 0) - p.n) < 0.01;
    return {
      t: p.t, side: p.side, n: p.n,
      cost: same && num(s.cost) != null ? num(s.cost) : p.cost,
      label: s && s.side === p.side ? s.label : null,
      group: s && s.side === p.side ? s.group : groupOf(p.t),
    };
  });
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

function autoLabel(m, p) {
  if (!m) return p.t;
  const name = m.yes_sub_title || m.title || p.t;
  return p.side === "no" ? "NO: " + name : name;
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (req.method !== "GET") return res.status(405).send("Read-only");
  if (!keyMatches(req.query.k)) return res.status(404).send("Not found");

  const saved = readPositions();
  let positions = saved, source = "saved", accountError = null;
  try {
    const live = await accountPositions();
    if (live) { positions = mergePositions(live, saved || []); source = "account"; }
  } catch (e) {
    accountError = String(e.message || e).slice(0, 500);   // never includes key material
  }
  if (positions === null) return res.status(500).json({ error: "BETS_POSITIONS is not valid JSON", accountError });

  const markets = await fetchMarkets([...new Set(positions.map((p) => p.t))]);
  const rows = positions.map((p) => {
    const m = markets.get(p.t);
    const v = sideValue(m, p.side);
    const n = num(p.n) || 0, cost = num(p.cost) || 0;
    return {
      ticker: p.t, label: p.label || autoLabel(m, p), group: p.group || groupOf(p.t),
      side: p.side, contracts: n, cost, costKnown: num(p.cost) != null,
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
    at: Date.now(), rows, source, accountError,
    totals: { cost: sum("cost"), value: +priced.reduce((s, r) => s + r.value, 0).toFixed(2), payout: sum("payout"), priced: priced.length, count: rows.length },
  });
}

module.exports = handler;
module.exports.sideValue = sideValue;
module.exports.keyMatches = keyMatches;
module.exports.signRequest = signRequest;
module.exports.loadPrivateKey = loadPrivateKey;
module.exports.mergePositions = mergePositions;
module.exports.groupOf = groupOf;
