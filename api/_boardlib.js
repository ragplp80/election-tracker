// Helpers for the private board (api/bets.js). Files starting with "_" are not served as endpoints.
//   stateOf      — which state a market is about (for the money map)
//   sellNow      — what you'd get selling a position right now
//   buildLine    — the market's expected margin / vote share / seat count vs. the line you need
//   nightHistory — your bets valued over time, from Kalshi's price history (no storage of our own)

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

// ---------- States ----------
const STATES = new Set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" "));
function stateOf(eventTicker) {
  const t = String(eventTicker || "").toUpperCase();
  const pats = [
    /^KXMIDTERMMOV-([A-Z]{2})/, /^KXMIDTERMVOTETURN-([A-Z]{2})/,
    /^KXVOTEGENERAL-(?:KX)?(?:GOVPARTY|SENATE|HOUSE)([A-Z]{2})/,
    /^(?:KX)?GOVPARTY([A-Z]{2})-/, /^(?:KX)?GOV([A-Z]{2})-/, /^(?:KX)?SENATE([A-Z]{2})S?-/,
    /^KXHOUSERACE-([A-Z]{2})\d/, /^(?:KX)?HOUSE([A-Z]{2})(?:\d|AL)/, /^KXSTATELEG-([A-Z]{2})/,
  ];
  for (const re of pats) { const m = t.match(re); if (m && STATES.has(m[1])) return m[1]; }
  return null;
}

// ---------- Pricing ----------
// A market's YES price now (0 to 1): settled markets pay 1 or 0; otherwise the bid/ask midpoint when
// the spread is tight, else the last trade, so a thin market doesn't swing the board on one stale
// quote. (Ladder rungs use ladderPrice below, which trusts a wider spread.)
function yesPrice(m) {
  if (!m) return null;
  if (m.result === "yes") return 1;
  if (m.result === "no") return 0;
  const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars);
  if (bid != null && ask != null && ask > 0 && ask - bid <= 0.1) return (bid + ask) / 2;
  return last ?? bid ?? ask;
}

// ---------- Selling now ----------
// Kalshi's trading fee: 7% of price x (1 - price) per contract, rounded up to the cent per order.
const feeFor = (n, p) => Math.ceil(0.07 * n * p * (1 - p) * 100 - 1e-9) / 100;

// Selling YES means hitting the best YES bid; selling NO means hitting the best NO bid.
function sellNow(m, side, n) {
  if (!m) return { bid: null, value: null };
  if (m.result === "yes" || m.result === "no") return { bid: null, value: null, settled: true };
  const bid = side === "yes" ? num(m.yes_bid_dollars) : num(m.no_bid_dollars) ?? (num(m.yes_ask_dollars) != null ? 1 - num(m.yes_ask_dollars) : null);
  if (bid == null || bid <= 0) return { bid: 0, value: 0, noBuyers: true };
  return { bid, value: +Math.max(0, n * bid - feeFor(n, bid)).toFixed(2) };
}

// ---------- The market's line ----------
// A ladder market's price, trusting the quotes when they're tight and the last trade otherwise.
function ladderPrice(m) {
  if (m.result === "yes") return 1;
  if (m.result === "no") return 0;
  const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars), last = num(m.last_price_dollars);
  if (bid != null && ask != null && ask > 0 && bid > 0 && ask - bid <= 0.15) return (bid + ask) / 2;
  if (last != null && last > 0) return last;
  if (bid != null && ask != null && ask > 0) return (bid + ask) / 2;
  return null;
}

// Pool adjacent violators: make P(value >= x) never rise as x rises. Thin ladders have stale
// rungs (15+ priced above 12+); this irons them out without throwing information away.
function nonIncreasing(points) {
  const blocks = [];
  for (const [x, p] of points) {
    blocks.push({ xs: [x], sum: p, n: 1 });
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1], a = blocks[blocks.length - 2];
      if (a.sum / a.n >= b.sum / b.n) break;
      blocks.splice(-2, 2, { xs: a.xs.concat(b.xs), sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  const out = [];
  for (const b of blocks) for (const x of b.xs) out.push([x, b.sum / b.n]);
  return out;
}

// Where P(value >= x) falls to s. Returns { x } or { beyond: "<"|">", bound }.
function crossing(pts, s) {
  if (!pts.length) return null;
  if (pts[0][1] < s) return { beyond: "<", bound: pts[0][0] };
  for (let i = 1; i < pts.length; i++) {
    const [x0, p0] = pts[i - 1], [x1, p1] = pts[i];
    if (p1 < s) return { x: p0 === p1 ? x0 : x0 + ((p0 - s) / (p0 - p1)) * (x1 - x0) };
  }
  return { beyond: ">", bound: pts[pts.length - 1][0] };
}

const nameBefore = (s) => { const n = String(s || "").split(",")[0].trim(); return n && !/^(at least|above|below)/i.test(n) ? n : null; };
const unitOf = (eventTicker) => /^KXMIDTERMMOV/i.test(eventTicker) ? "pts" : /^KXVOTEGENERAL/i.test(eventTicker) ? "%" : /SEATS/i.test(eventTicker) ? "seats" : "";

// For KXMIDTERMMOV-TXGOVR ("Republicans win by x+") the other side is KXMIDTERMMOV-TXGOVD.
function counterpartEvent(ev) {
  const m = String(ev || "").match(/^(KXMIDTERMMOV-[A-Z]{2}(?:GOV|SEN|SENS|\d+|AL))([RD])$/);
  return m ? m[1] + (m[2] === "R" ? "D" : "R") : null;
}

// The market's middle estimate and likely range for the thing your bet is about, and the line you need.
//   m: your market; side: "yes"|"no"; own: markets in its event; other: the counterpart event's markets
function buildLine(m, side, own, other) {
  if (!m || !own || !own.length) return null;
  const unit = unitOf(m.event_ticker);
  const between = own.some((x) => x.strike_type === "between");
  if (between) return seatsLine(m, side, own, unit);
  if (m.floor_strike == null || !/greater/.test(m.strike_type || "")) return null;

  // P(margin >= x) for this party's side; the other party's ladder gives the negative side.
  const pts = [];
  for (const x of own) { const p = ladderPrice(x), k = num(x.floor_strike); if (p != null && k != null && /greater/.test(x.strike_type || "")) pts.push([k, p]); }
  for (const x of other || []) { const p = ladderPrice(x), k = num(x.floor_strike); if (p != null && k != null && /greater/.test(x.strike_type || "")) pts.push([-k, 1 - p]); }
  if (pts.length < 2) return null;
  pts.sort((a, b) => a[0] - b[0]);
  const s = nonIncreasing(pts);
  const mid = crossing(s, 0.5), lo = crossing(s, 0.8), hi = crossing(s, 0.2);
  const k = num(m.floor_strike);
  const need = side === "yes" ? { op: ">=", a: k } : { op: "<", a: k };
  const median = mid && mid.x != null ? +mid.x.toFixed(1) : null;
  const room = median == null ? null : +(side === "yes" ? median - k : k - median).toFixed(1);
  return {
    kind: unit === "%" ? "share" : "margin", unit,
    who: nameBefore(m.yes_sub_title), other: other && other.length ? nameBefore(other[0].yes_sub_title) : null,
    median, beyond: mid && mid.beyond ? mid.beyond : null, bound: mid && mid.bound != null ? mid.bound : null,
    // Likely range (80% to 20% chance); past the end of the ladder it stops at the last rung
    lo: lo ? +(lo.x != null ? lo.x : lo.bound).toFixed(1) : null, hi: hi ? +(hi.x != null ? hi.x : hi.bound).toFixed(1) : null,
    loOpen: !!(lo && lo.beyond), hiOpen: !!(hi && hi.beyond),
    need, room, rungs: s.length,
  };
}

// Seat-count style ladders: one market per range ("238-241"). Spread each range's chance evenly
// across its seats, and read off the middle and the likely range.
function seatsLine(m, side, own, unit) {
  const buckets = [];
  for (const x of own) {
    const p = ladderPrice(x); if (p == null) continue;
    let a = num(x.floor_strike), b = num(x.cap_strike);
    if (x.strike_type === "between" && a != null && b != null) buckets.push([a, b + 1, p]);
    else if (/less/.test(x.strike_type || "") && b != null) buckets.push([b - 3, b + (x.strike_type === "less_or_equal" ? 1 : 0), p]);
    else if (/greater/.test(x.strike_type || "") && a != null) buckets.push([a + (x.strike_type === "greater" ? 1 : 0), a + 5, p]);
  }
  if (buckets.length < 3) return null;
  buckets.sort((u, v) => u[0] - v[0]);
  const total = buckets.reduce((s, b) => s + b[2], 0);
  if (!(total > 0)) return null;
  const q = (target) => {
    let acc = 0;
    for (const [a, b, p] of buckets) {
      const w = p / total;
      if (acc + w >= target) return a + ((target - acc) / w) * (b - a);
      acc += w;
    }
    return buckets[buckets.length - 1][1];
  };
  const a = num(m.floor_strike), b = num(m.cap_strike);
  if (a == null || b == null) return null;
  const median = Math.round(q(0.5));
  const inside = Math.min(median - a, b - median);
  return {
    kind: "seats", unit: unit || "seats", who: /democrat/i.test(m.title || "") ? "Democrats" : /republican/i.test(m.title || "") ? "Republicans" : null, other: null,
    median, beyond: null, bound: null, lo: Math.round(q(0.2)), hi: Math.round(q(0.8)),
    need: side === "yes" ? { op: "in", a, b } : { op: "out", a, b },
    room: side === "yes" ? inside : -inside, rungs: buckets.length,
  };
}

// ---------- Night history ----------
const RANGES = {
  "6h": { secs: 6 * 3600, period: 1, step: 120 },
  "24h": { secs: 86400, period: 1, step: 480 },
  "3d": { secs: 3 * 86400, period: 60, step: 3600 },
  "7d": { secs: 7 * 86400, period: 60, step: 3600 },
};

// A packed candle [end_ts, close, previous, bid close, ask close] -> YES price, or null
function candleYes(c) {
  const close = num(c[1]), bid = num(c[3]), ask = num(c[4]);
  if (bid != null && ask != null && bid > 0 && ask > 0 && ask - bid <= 0.1) return (bid + ask) / 2;
  return close;
}

// Step a market's candles onto the shared timeline: the latest known price at or before each time.
function onTimeline(candles, times, nowYes) {
  const pts = (candles || []).map((c) => [c[0], candleYes(c)]).filter((p) => p[1] != null).sort((a, b) => a[0] - b[0]);
  const out = new Array(times.length).fill(null);
  let j = -1;
  for (let i = 0; i < times.length; i++) {
    while (j + 1 < pts.length && pts[j + 1][0] <= times[i]) j++;
    out[i] = j >= 0 ? pts[j][1] : null;
  }
  const firstKnown = out.find((v) => v != null) ?? nowYes ?? null;   // before the first candle: hold the first price
  for (let i = 0; i < out.length && out[i] == null; i++) out[i] = firstKnown;
  if (nowYes != null) out[out.length - 1] = nowYes;                  // the last point is the live price
  return out;
}

// rows: the board's rows (with ticker, side, contracts, cost, value, price, legs)
// markets / legMarkets: Map ticker -> Kalshi market; getHistory(series, ticker, period, start, end) -> packed candles
async function nightHistory(rows, markets, legMarkets, rangeKey, getHistory, poolFn) {
  const R = RANGES[rangeKey] || RANGES["6h"];
  const now = Math.floor(Date.now() / 1000);
  const start = Math.floor((now - R.secs) / R.step) * R.step;
  const times = [];
  for (let t = start; t < now; t += R.step) times.push(t);
  times.push(now);

  const want = new Map();   // ticker -> market
  for (const r of rows) {
    if (r.legs) for (const l of r.legs) { const lm = legMarkets.get(l.ticker); if (lm) want.set(l.ticker, lm); }
    else { const m = markets.get(r.ticker); if (m) want.set(r.ticker, m); }
  }
  const tickers = [...want.keys()];
  const fetched = await poolFn(tickers, 4, async (t) => {
    const m = want.get(t), series = String(m.event_ticker || t).split("-")[0];
    return getHistory(series, t, R.period, start - R.step * 2, now);
  });
  const yesSeries = new Map(), missing = [];
  tickers.forEach((t, i) => {
    const c = fetched[i] && !fetched[i].error ? fetched[i] : null;
    if (!c || !c.length) missing.push(t);
    yesSeries.set(t, onTimeline(c || [], times, yesPrice(want.get(t))));
  });

  const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
  const bets = {}, parlays = {};
  const worth = new Array(times.length).fill(0);
  let cost = 0;
  for (const r of rows) {
    cost += r.cost || 0;
    if (r.legs) {
      const legYes = r.legs.map((l) => ({ s: yesSeries.get(l.ticker), side: l.side }));
      parlays[r.ticker] = times.map((_, i) => r3(legYes.reduce((p, l) => (p == null || !l.s || l.s[i] == null ? null : p * (l.side === "yes" ? l.s[i] : 1 - l.s[i])), 1)));
      for (let i = 0; i < times.length; i++) worth[i] += r.value || 0;   // parlays: held at their last trade
      continue;
    }
    const s = yesSeries.get(r.ticker);
    const chance = times.map((_, i) => (s && s[i] != null ? (r.side === "yes" ? s[i] : 1 - s[i]) : r.price));
    bets[r.ticker] = chance.map(r3);
    for (let i = 0; i < times.length; i++) worth[i] += chance[i] == null ? r.value || 0 : chance[i] * r.contracts;
  }
  return {
    at: Date.now(), range: rangeKey in RANGES ? rangeKey : "6h", t: times,
    worth: worth.map((v) => +v.toFixed(2)), pl: worth.map((v) => +(v - cost).toFixed(2)), cost: +cost.toFixed(2),
    bets, parlays, missing,
  };
}

module.exports = { yesPrice, stateOf, sellNow, nonIncreasing, crossing, buildLine, counterpartEvent, nightHistory, RANGES };
