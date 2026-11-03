// The board's helpers: states, selling now, the market's line, and the night history.
const test = require("node:test");
const assert = require("node:assert/strict");
const B = require("../api/_boardlib.js");

const mk = (o) => ({ status: "active", ...o });
const rung = (event, k, p, name = "Abbott") => mk({ event_ticker: event, ticker: `${event}-P${k}`, floor_strike: k, strike_type: "greater_or_equal", yes_sub_title: `${name}, ${k}+ pts`, yes_bid_dollars: (p - 0.01).toFixed(4), yes_ask_dollars: (p + 0.01).toFixed(4), last_price_dollars: p.toFixed(4) });

test("boardlib: state from the event ticker", () => {
  const cases = {
    "KXMIDTERMMOV-TXGOVR": "TX", "KXMIDTERMMOV-NESENDOSB": "NE", "GOVPARTYFL-26": "FL", "SENATEOHS-26": "OH", "SENATEMS-26": "MS",
    "KXHOUSERACE-OH10-26": "OH", "KXSTATELEG-NCHOUSE26": "NC", "KXVOTEGENERAL-GOVPARTYOK-26": "OK", "HOUSEPA7-26": "PA",
    "CONTROLH-2026": null, "KXDHOUSESEATS-27": null, "KXMVECROSSCATEGORY-S2026X": null,
  };
  for (const [ev, st] of Object.entries(cases)) assert.equal(B.stateOf(ev), st, ev);
});

test("boardlib: sell now = your side's bid less Kalshi's fee", () => {
  const m = { yes_bid_dollars: "0.4700", yes_ask_dollars: "0.5000", no_bid_dollars: "0.5000" };
  // 20 YES at 47¢ = 9.40, fee ceil(0.07*20*.47*.53*100)/100 = 0.35
  assert.deepEqual(B.sellNow(m, "yes", 20), { bid: 0.47, value: 9.05 });
  assert.equal(B.sellNow(m, "no", 10).bid, 0.5);
  assert.equal(B.sellNow({ yes_bid_dollars: "0.0000", yes_ask_dollars: "1.0000", no_bid_dollars: "0" }, "yes", 100).noBuyers, true);
  assert.equal(B.sellNow({ result: "yes" }, "yes", 5).settled, true);
});

test("boardlib: stale ladder rungs are ironed flat, never rising", () => {
  const out = B.nonIncreasing([[1, 0.9], [2, 0.6], [3, 0.7], [4, 0.2]]);
  assert.deepEqual(out.map((p) => +p[1].toFixed(3)), [0.9, 0.65, 0.65, 0.2]);
});

test("boardlib: margin line combines both parties' ladders", () => {
  // Abbott (R) by x+: 1:70%, 2:60%, 3:45%, 5:25%;  Hinojosa (D) by x+: 1:20%, 3:8%
  const own = [rung("KXMIDTERMMOV-TXGOVR", 1, 0.7), rung("KXMIDTERMMOV-TXGOVR", 2, 0.6), rung("KXMIDTERMMOV-TXGOVR", 3, 0.45), rung("KXMIDTERMMOV-TXGOVR", 5, 0.25)];
  const other = [rung("KXMIDTERMMOV-TXGOVD", 1, 0.2, "Hinojosa"), rung("KXMIDTERMMOV-TXGOVD", 3, 0.08, "Hinojosa")];
  const mine = own[2];   // Abbott 3+
  const L = B.buildLine(mine, "no", own, other);
  assert.equal(L.kind, "margin");
  assert.equal(L.who, "Abbott");
  assert.equal(L.other, "Hinojosa");
  // P(>=2)=.6, P(>=3)=.45 -> crosses 50% at 2 + (.1/.15) = 2.67
  assert.equal(L.median, 2.7);
  assert.deepEqual(L.need, { op: "<", a: 3 });
  assert.equal(L.room, 0.3, "NO on 3+: room = 3 - 2.7");
  assert.ok(L.lo < L.median && L.hi >= L.median, "likely range brackets the middle");
  assert.equal(L.hiOpen, true, "top of the range runs past the last rung");
  assert.ok(L.lo < 0, "the other party's ladder extends the range below zero");
  const yes = B.buildLine(mine, "yes", own, other);
  assert.equal(yes.room, -0.3);
});

test("boardlib: a market expected well past the ladder says so instead of guessing", () => {
  const own = [rung("KXMIDTERMMOV-IDSENR", 13, 0.8, "Risch"), rung("KXMIDTERMMOV-IDSENR", 15, 0.7, "Risch"), rung("KXMIDTERMMOV-IDSENR", 17, 0.6, "Risch")];
  const L = B.buildLine(own[1], "no", own, null);
  assert.equal(L.median, null);
  assert.equal(L.beyond, ">");
  assert.equal(L.bound, 17);
});

test("boardlib: seat ranges give a middle estimate and whether your range is in it", () => {
  const ev = "KXDHOUSESEATS-27";
  const b = (a, c, p) => mk({ event_ticker: ev, ticker: `${ev}-${a}`, floor_strike: a, cap_strike: c, strike_type: "between", title: "Will the Democratic party win seats?", yes_bid_dollars: (p - 0.005).toFixed(4), yes_ask_dollars: (p + 0.005).toFixed(4) });
  const own = [b(226, 229, 0.1), b(230, 233, 0.15), b(234, 237, 0.25), b(238, 241, 0.25), b(242, 245, 0.15), b(246, 249, 0.1)];
  const L = B.buildLine(own[3], "yes", own, null);
  assert.equal(L.kind, "seats");
  assert.equal(L.who, "Democrats");
  assert.equal(L.median, 238);
  assert.deepEqual(L.need, { op: "in", a: 238, b: 241 });
  assert.equal(L.room, 0, "right at the edge of the range");
});

test("boardlib: counterpart events swap R and D", () => {
  assert.equal(B.counterpartEvent("KXMIDTERMMOV-TXGOVR"), "KXMIDTERMMOV-TXGOVD");
  assert.equal(B.counterpartEvent("KXMIDTERMMOV-LASENR"), "KXMIDTERMMOV-LASEND");
  assert.equal(B.counterpartEvent("KXMIDTERMMOV-NESENDOSB"), null);
});

test("boardlib: night history values your bets over time and marks gaps", async () => {
  const now = Math.floor(Date.now() / 1000);
  const markets = new Map([
    ["A", { ticker: "A", event_ticker: "SENATETX-26", yes_bid_dollars: "0.69", yes_ask_dollars: "0.71" }],
    ["B", { ticker: "B", event_ticker: "GOVPARTYFL-26", yes_bid_dollars: "0.39", yes_ask_dollars: "0.41" }],
  ]);
  const legMarkets = new Map([
    ["L1", { ticker: "L1", event_ticker: "SENATEGA-26", yes_bid_dollars: "0.89", yes_ask_dollars: "0.91" }],
    ["L2", { ticker: "L2", event_ticker: "SENATEMI-26", yes_bid_dollars: "0.49", yes_ask_dollars: "0.51" }],
  ]);
  const rows = [
    { ticker: "A", side: "yes", contracts: 10, cost: 5, price: 0.7, value: 7 },
    { ticker: "B", side: "no", contracts: 10, cost: 6, price: 0.6, value: 6 },
    { ticker: "P", side: "yes", contracts: 100, cost: 20, price: 0.3, value: 30, legs: [{ ticker: "L1", side: "yes" }, { ticker: "L2", side: "yes" }] },
  ];
  const asked = [];
  const getHistory = async (series, ticker, period, start, end) => {
    asked.push([series, ticker, period]);
    if (ticker === "B") return [];                                   // no history: flat at the live price
    const p = { A: 0.5, L1: 0.8, L2: 0.4 }[ticker];
    return [[start + 60, String(p), null, null, null]];
  };
  const pool = async (items, n, fn) => Promise.all(items.map((x) => fn(x).catch((e) => ({ error: String(e) }))));
  const h = await B.nightHistory(rows, markets, legMarkets, "6h", getHistory, pool);
  assert.equal(h.range, "6h");
  assert.ok(h.t.length > 100 && h.t[h.t.length - 1] >= now);
  assert.deepEqual(asked.find((a) => a[1] === "A"), ["SENATETX", "A", 1]);
  assert.equal(h.bets.A[1], 0.5, "early on, A was at 50¢");
  assert.equal(h.bets.A[h.bets.A.length - 1], 0.7, "the last point is the live price");
  assert.ok(h.bets.B.every((v) => v === 0.6), "no history: flat at the live NO price");
  assert.deepEqual(h.missing, ["B"]);
  assert.equal(h.parlays.P[1], 0.32, "parlay trend = legs multiplied");
  assert.equal(h.cost, 31);
  // last point: A 7 + B 6 + parlay 30 = 43 worth, P/L 12
  assert.equal(h.worth[h.worth.length - 1], 43);
  assert.equal(h.pl[h.pl.length - 1], 12);
  // early point: A 5 + B 6 + 30 = 41
  assert.equal(h.pl[1], 10);
});
