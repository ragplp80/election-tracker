// How Kalshi series map to races, and which events count as 2026.
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../core.js");

test("recognizes each Kalshi series style", () => {
  assert.deepEqual(Core.classify("SENATETX"), { type: "senate", st: "TX", special: false, pref: 2 });
  assert.deepEqual(Core.classify("SENATEOHS"), { type: "senate", st: "OH", special: true, pref: 2 });
  assert.equal(Core.classify("KXSENATEAK").pref, 1);
  assert.deepEqual(Core.classify("GOVPARTYAZ"), { type: "gov", st: "AZ", pref: 2 });
  assert.equal(Core.classify("GOVPARTY-NH").st, "NH");
  assert.equal(Core.classify("KXGOVPARTYFL").pref, 1);
  assert.deepEqual(Core.classify("HOUSEPA7"), { type: "house", st: "PA", dist: 7, special: false, pref: 2 });
  assert.equal(Core.classify("HOUSEAKAL").dist, 0);
  assert.equal(Core.classify("HOUSEPARTY-MI07").dist, 7);
  assert.equal(Core.classify("KXHOUSENC11").dist, 11);
  assert.equal(Core.classify("CONTROLS").type, "ctlS");
  assert.equal(Core.classify("CONTROLH").type, "ctlH");
  assert.equal(Core.classify("KXDHOUSESEATS").type, "seats");
});

test("ignores series that aren't races we track", () => {
  for (const t of ["KXNYCCOUNCIL8", "KXSENATEDEMLEAD", "SENATEMOV", "KXCLOSESTSENATE", "HOUSE", "SENATE", "SENATEXX", "KXLTGOVTX", "GOVPARTYXX"])
    assert.equal(Core.classify(t), null, t);
});

test("keeps only 2026 events (Kentucky governor 2027 is out)", () => {
  const state = { type: "gov" };
  assert.ok(Core.is2026(state, { event_ticker: "GOVPARTYAZ-26" }));
  assert.ok(!Core.is2026(state, { event_ticker: "GOVPARTYKY-27" }));
  assert.ok(Core.is2026({ type: "senate" }, { event_ticker: "SENATEAK-26B" }));
  assert.ok(Core.is2026({ type: "ctlS" }, { event_ticker: "CONTROLS-2026" }));
  assert.ok(!Core.is2026({ type: "ctlS" }, { event_ticker: "CONTROLS-2028" }));
  assert.ok(Core.is2026({ type: "seats" }, { event_ticker: "KXDHOUSESEATS-27" }));
});

test("one key per race, so duplicate series collapse", () => {
  assert.equal(Core.seriesKey(Core.classify("SENATEAK")), Core.seriesKey(Core.classify("KXSENATEAK")));
  assert.notEqual(Core.seriesKey(Core.classify("SENATEOH")), Core.seriesKey(Core.classify("SENATEOHS")));
});

test("slimming keeps only the fields the page uses", () => {
  const m = Core.slimMarket({ ticker: "X", yes_bid_dollars: "0.5", rules_primary: "long text", custom_strike: {} });
  assert.deepEqual(m, { ticker: "X", yes_bid_dollars: "0.5" });
});
