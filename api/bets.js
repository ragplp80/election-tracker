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
const { kget, pool } = require("./_lib.js");
const Board = require("./_boardlib.js");
const History = require("./history.js");

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

// Every market traded on the account, open or closed: [{ t, side, n, cost, realized, fees, traded }]
// n is 0 for positions you've sold out of (or that have settled); realized is Kalshi's locked-in P/L.
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
    const j = await signedGet(keyId, key, `/portfolio/positions?limit=200&count_filter=total_traded${cursor ? "&cursor=" + encodeURIComponent(cursor) : ""}`);
    for (const m of j.market_positions || []) {
      const pos = num(m.position_fp) ?? num(m.position) ?? 0;
      const realized = dollars(m, "realized_pnl") || 0, fees = dollars(m, "fees_paid") || 0, traded = dollars(m, "total_traded") || 0;
      if (!m.ticker || (!pos && !realized && !traded)) continue;
      out.push({ t: m.ticker, side: pos > 0 ? "yes" : pos < 0 ? "no" : null, n: Math.abs(pos), cost: dollars(m, "market_exposure"), realized, fees, traded });
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
      t: p.t, side: p.side, n: p.n, realized: p.realized || 0,
      cost: same && num(s.cost) != null ? num(s.cost) : p.cost,
      label: s && s.side === p.side ? s.label : null,
      group: s && s.side === p.side ? s.group : groupOf(p.t),
    };
  });
}

// Kalshi page for an event: kalshi.com/markets/<series>/m/<event> (the app opens these too)
// Series whose pages need Kalshi's real slug (the short "/m/" form doesn't open them in the Kalshi app)
const KALSHI_SLUGS = {
  kxmidtermmov: "midterm-margin-of-victory",
  kxvotegeneral: "vote-percentages-in-us-general-elections",
  kxmidtermvoteturn: "kxmidtermvoteturn",
};
function kalshiUrl(eventTicker) {
  const ev = String(eventTicker || "").toLowerCase();
  if (!ev) return null;
  const series = ev.split("-")[0];
  return `https://kalshi.com/markets/${series}/${KALSHI_SLUGS[series] || "m"}/${ev}`;
}

// What it costs right now to buy the OTHER side of a market (the hedge side), from the order book quotes
function oppositeAsk(m, side) {
  if (!m) return null;
  const a = side === "yes" ? num(m.no_ask_dollars) : num(m.yes_ask_dollars);
  if (a != null && a > 0 && a < 1) return a;
  const bid = side === "yes" ? num(m.yes_bid_dollars) : num(m.no_bid_dollars);
  return bid != null && bid > 0 && bid < 1 ? +(1 - bid).toFixed(4) : null;
}

// ---------- Parlay legs ----------
// "GOVPARTYGA-26" -> "GA Gov", "SENATEOHS-26" -> "OH Sen (special)", "CONTROLH-2026" -> "House control"
function legRace(eventTicker) {
  const t = String(eventTicker || "");
  let m;
  if (/^CONTROLH/.test(t)) return "House control";
  if (/^CONTROLS/.test(t)) return "Senate control";
  if ((m = t.match(/^(?:KX)?GOVPARTY([A-Z]{2})-/))) return m[1] + " Gov";
  if ((m = t.match(/^(?:KX)?SENATE([A-Z]{2})S-/))) return m[1] + " Sen (special)";
  if ((m = t.match(/^(?:KX)?SENATE([A-Z]{2})-/))) return m[1] + " Sen";
  if ((m = t.match(/^KXHOUSERACE-([A-Z]{2})(\d+)-/))) return `${m[1]}-${m[2]}`;
  return t;
}

// The legs of a parlay, each priced on the side the parlay needs, with yesterday's close for trend.
function buildLegs(m, legMarkets) {
  const legs = (m && m.mve_selected_legs) || [];
  if (!legs.length) return null;
  const out = legs.map((l) => {
    const lm = legMarkets.get(l.market_ticker);
    const side = l.side === "no" ? "no" : "yes";
    const price = sideValue(lm, side);
    const prevYes = lm ? num(lm.previous_price_dollars) : null;
    const prev = prevYes == null ? null : side === "yes" ? prevYes : 1 - prevYes;
    let name = lm ? lm.yes_sub_title || lm.title || l.market_ticker : l.market_ticker;
    if (/^democratic party$/i.test(name)) name = "Democrats";
    if (/^republican party$/i.test(name)) name = "Republicans";
    return {
      ticker: l.market_ticker, race: legRace(l.event_ticker), name: side === "no" ? "Not " + name : name, side,
      price, prev, result: lm && lm.result ? lm.result : null,
      hedgeSide: side === "yes" ? "no" : "yes", hedgeAsk: oppositeAsk(lm, side),
      hedgeName: lm ? (side === "yes" ? "Not " : "") + (lm.yes_sub_title || lm.title || l.market_ticker) : null,
      url: kalshiUrl(l.event_ticker || (lm && lm.event_ticker)),
      st: Board.stateOf(l.event_ticker || (lm && lm.event_ticker)),
    };
  });
  // Rough "all legs hit" chance if the races were independent. Real races move together, so the
  // true chance is usually higher than this; it's a guide, not a price.
  const allPriced = out.every((l) => l.price != null);
  const combined = allPriced ? out.reduce((p, l) => p * l.price, 1) : null;
  return { legs: out, combined, ahead: out.filter((l) => l.price != null && l.price >= 0.5).length, won: out.filter((l) => l.price === 1).length, lost: out.filter((l) => l.price === 0).length };
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

// Every market in an event (a margin or seat ladder), or null if Kalshi doesn't have it
async function fetchEventMarkets(ev) {
  try {
    const j = await kget(`/events/${encodeURIComponent(ev)}?with_nested_markets=true`, { retries: 2 });
    return (j.event && j.event.markets) || j.markets || null;
  } catch (e) { return null; }
}

// Ladder bets (margins, vote shares, seat ranges): the market's middle estimate vs. your line
async function linesFor(rows, markets) {
  const want = new Map();   // event -> counterpart event (or null)
  for (const r of rows) {
    const m = markets.get(r.ticker);
    if (!m || r.legs || !m.event_ticker) continue;
    const ladderish = /greater|between/.test(m.strike_type || "") && (m.floor_strike != null);
    if (!ladderish) continue;
    want.set(m.event_ticker, Board.counterpartEvent(m.event_ticker));
  }
  const evs = new Set();
  for (const [e, c] of want) { evs.add(e); if (c) evs.add(c); }
  const list = [...evs];
  const got = await pool(list, 4, fetchEventMarkets);
  const byEv = new Map(list.map((e, i) => [e, Array.isArray(got[i]) ? got[i] : null]));
  for (const r of rows) {
    const m = markets.get(r.ticker);
    if (!m || !want.has(m.event_ticker)) continue;
    try { r.line = Board.buildLine(m, r.side, byEv.get(m.event_ticker), byEv.get(want.get(m.event_ticker))); } catch (e) { r.line = null; }
  }
}

// Price history for the night chart, kept in the tracker's shared store (api/history.js)
async function getHistory(series, ticker, period, start, end) {
  const { h } = await History.history(series, ticker, period, start, end);
  return h.c.filter((c) => c[0] >= start && c[0] <= end);
}
const historyCache = new Map();   // range|positions -> { at, body }

// Name for a bet that's on the account but not in the saved list: "VA-05: Perriello wins"
function autoLabel(m, p) {
  if (!m) return p.t;
  const name = m.yes_sub_title || m.title || p.t;
  const race = legRace(m.event_ticker);
  if (race && race !== m.event_ticker && !/margin|vote|seats/i.test(m.title || "")) {
    const last = name.split(" ").length > 1 && !/party$/i.test(name) ? name.split(" ").slice(-1)[0] : name;
    return p.side ? `${race}: ${last} ${p.side === "no" ? "loses" : "wins"}` : `${race}: ${last}`;
  }
  return p.side === "no" ? "NO: " + name : name;
}

async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  if (req.method !== "GET") return res.status(405).send("Read-only");
  if (!keyMatches(req.query.k)) return res.status(404).send("Not found");

  const saved = readPositions();
  let positions = saved, source = "saved", accountError = null, closedLive = [];
  try {
    const live = await accountPositions();
    if (live) {
      positions = mergePositions(live.filter((p) => p.n > 0.0001), saved || []);
      closedLive = live.filter((p) => p.n <= 0.0001 && (p.realized || p.traded));
      source = "account";
    }
  } catch (e) {
    accountError = String(e.message || e).slice(0, 500);   // never includes key material
  }
  if (positions === null) return res.status(500).json({ error: "BETS_POSITIONS is not valid JSON", accountError });

  const markets = await fetchMarkets([...new Set(positions.map((p) => p.t).concat(closedLive.map((p) => p.t)))]);
  // Parlays: price every leg too
  const legTickers = new Set();
  for (const m of markets.values()) for (const l of m.mve_selected_legs || []) if (l.market_ticker) legTickers.add(l.market_ticker);
  const legMarkets = legTickers.size ? await fetchMarkets([...legTickers]) : new Map();
  const rows = positions.map((p) => {
    const m = markets.get(p.t);
    const parlay = buildLegs(m, legMarkets);
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
      url: m && !parlay ? kalshiUrl(m.event_ticker) : null,
      st: m && !parlay ? Board.stateOf(m.event_ticker) : null,
      sell: Board.sellNow(m, p.side, n),
      lockedIn: p.realized ? +p.realized.toFixed(2) : 0,  // from selling part of this position (Kalshi's figure)
      ...(parlay ? { legs: parlay.legs, legsCombined: parlay.combined, legsAhead: parlay.ahead, legsWon: parlay.won, legsLost: parlay.lost } : {}),
    };
  });
  // The night chart: ?view=history&range=6h|24h|3d|7d
  if (req.query.view === "history") {
    const range = Board.RANGES[req.query.range] ? req.query.range : "6h";
    const ckey = range + "|" + rows.map((r) => r.ticker + ":" + r.side + ":" + r.contracts).join(",");
    const hit = historyCache.get(ckey);
    if (hit && Date.now() - hit.at < 45000) return res.status(200).json(hit.body);
    try {
      const body = await Board.nightHistory(rows, markets, legMarkets, range, getHistory, pool);
      historyCache.set(ckey, { at: Date.now(), body });
      if (historyCache.size > 20) historyCache.delete(historyCache.keys().next().value);
      return res.status(200).json(body);
    } catch (e) {
      return res.status(502).json({ error: "history unavailable" });
    }
  }

  // Positions you've cashed out of, or that have settled: Kalshi's locked-in P/L, less every fee paid on them
  const savedBy = new Map((saved || []).map((p) => [p.t, p]));
  const closed = closedLive.map((p) => {
    const m = markets.get(p.t), sv = savedBy.get(p.t);
    return {
      ticker: p.t, label: (sv && sv.label) || autoLabel(m, { t: p.t, side: null }), group: (sv && sv.group) || groupOf(p.t),
      how: m && m.result ? "settled" : "cashed out", spent: +(p.traded || 0).toFixed(2),
      realized: +p.realized.toFixed(2), fees: +p.fees.toFixed(2), net: +(p.realized - p.fees).toFixed(2),
      url: m ? kalshiUrl(m.event_ticker) : null,
    };
  }).sort((a, b) => b.net - a.net);

  await linesFor(rows, markets);
  const sum = (k) => +rows.reduce((s, r) => s + (r[k] || 0), 0).toFixed(2);
  const priced = rows.filter((r) => r.value != null);
  const sellable = rows.reduce((s, r) => s + (r.sell && r.sell.value != null ? r.sell.value : r.result ? r.value || 0 : 0), 0);
  return res.status(200).json({
    at: Date.now(), rows, closed, source, accountError,
    totals: {
      cost: sum("cost"), value: +priced.reduce((s, r) => s + r.value, 0).toFixed(2), payout: sum("payout"), priced: priced.length, count: rows.length, sell: +sellable.toFixed(2),
      cashedOut: +closed.reduce((s, c) => s + c.net, 0).toFixed(2),   // closed positions, after fees
      lockedIn: sum("lockedIn"),                                         // partial sells on open positions, before fees
    },
  });
}

module.exports = handler;
module.exports.sideValue = sideValue;
module.exports.keyMatches = keyMatches;
module.exports.signRequest = signRequest;
module.exports.loadPrivateKey = loadPrivateKey;
module.exports.mergePositions = mergePositions;
module.exports.groupOf = groupOf;
module.exports.legRace = legRace;
module.exports.buildLegs = buildLegs;
module.exports.kalshiUrl = kalshiUrl;
module.exports.oppositeAsk = oppositeAsk;
