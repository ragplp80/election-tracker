// The private positions board: key check, settings parsing, and pricing against a fake Kalshi.
const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultBoard, useFakeKalshi, callHandler } = require("./helpers.js");
const bets = require("../api/bets.js");

const KEY = "test-key-0123456789abcdef";
function withEnv(env, fn) {
  return async () => {
    const old = { BETS_KEY: process.env.BETS_KEY, BETS_POSITIONS: process.env.BETS_POSITIONS };
    Object.assign(process.env, env);
    const restore = useFakeKalshi(defaultBoard(), []);
    try { await fn(); } finally {
      restore();
      for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}
const POS = JSON.stringify([
  { t: "SENATETX-26-D", side: "yes", n: 20, cost: 12, label: "TX Sen: Talarico", group: "Senate" },
  { t: "GOVPARTYAZ-26-R", side: "no", n: 10, cost: 8, label: "AZ Gov: Biggs loses", group: "Governor" },
  { t: "NOPE-1", side: "yes", n: 5, cost: 2, label: "Gone", group: "Other" },
]);

test("bets: wrong or missing key looks like a missing page", withEnv({ BETS_KEY: KEY, BETS_POSITIONS: POS }, async () => {
  for (const q of [{}, { k: "" }, { k: "wrong" }, { k: KEY + "x" }]) {
    const res = await callHandler(bets, q);
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers["cache-control"], "no-store");
  }
}));

test("bets: refuses to open with a short or unset key", withEnv({ BETS_KEY: "short", BETS_POSITIONS: POS }, async () => {
  const res = await callHandler(bets, { k: "short" });
  assert.equal(res.statusCode, 404);
}));

test("bets: prices each position on its own side, totals add up", withEnv({ BETS_KEY: KEY, BETS_POSITIONS: POS }, async () => {
  const res = await callHandler(bets, { k: KEY });
  assert.equal(res.statusCode, 200);
  const [tx, az, gone] = res.body.rows;
  assert.ok(Math.abs(tx.price - 0.68) < 1e-9, "yes side = yes midpoint");
  assert.ok(Math.abs(az.price - 0.9) < 1e-9, "no side = 1 - yes");   // Biggs yes ~0.10
  assert.equal(tx.value, 13.6);
  assert.equal(gone.price, null, "unknown ticker has no price");
  assert.equal(res.body.totals.cost, 22);
  assert.equal(res.body.totals.payout, 35);
  assert.equal(res.body.totals.priced, 2);
}));

test("bets: settled markets pay 1 or 0", () => {
  assert.equal(bets.sideValue({ result: "no" }, "no"), 1);
  assert.equal(bets.sideValue({ result: "no" }, "yes"), 0);
  assert.equal(bets.sideValue({ yes_bid_dollars: "0.30", yes_ask_dollars: "0.70", last_price_dollars: "0.44" }, "no"), 0.56, "wide spread uses last trade");
});

test("bets: bad settings JSON is reported, not crashed on", withEnv({ BETS_KEY: KEY, BETS_POSITIONS: "{oops" }, async () => {
  const res = await callHandler(bets, { k: KEY });
  assert.equal(res.statusCode, 500);
}));
