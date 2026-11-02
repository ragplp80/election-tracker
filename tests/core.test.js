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
  assert.ok(!Core.is2026({ type: "gov", st: "KY" }, { event_ticker: "GOVPARTYKY-27" }));
  assert.ok(Core.is2026({ type: "gov", st: "KS" }, { event_ticker: "GOVPARTYKS-27" }), "Kansas: named for inauguration year");
  assert.ok(Core.is2026({ type: "gov", st: "NH" }, { event_ticker: "GOVPARTYNH-28" }), "New Hampshire: named for the term's end");
  assert.ok(Core.is2026({ type: "senate" }, { event_ticker: "SENATEAK-26B" }));
  assert.ok(Core.is2026({ type: "ctlS" }, { event_ticker: "CONTROLS-2026" }));
  assert.ok(!Core.is2026({ type: "ctlS" }, { event_ticker: "CONTROLS-2028" }));
  assert.ok(Core.is2026({ type: "seats" }, { event_ticker: "KXDHOUSESEATS-27" }));
});

test("one key per race, so duplicate series collapse", () => {
  assert.equal(Core.seriesKey(Core.classify("SENATEAK")), Core.seriesKey(Core.classify("KXSENATEAK")));
  assert.equal(Core.seatKey(Core.classify("SENATEOH")), Core.seatKey(Core.classify("SENATEOHS")), "Ohio has one Senate seat up (the special)");
});

test("slimming keeps only the fields the page uses", () => {
  const m = Core.slimMarket({ ticker: "X", yes_bid_dollars: "0.5", rules_primary: "long text", custom_strike: {} });
  assert.deepEqual(m, { ticker: "X", yes_bid_dollars: "0.5" });
});

test("person markets are recognized as backups that party markets outrank", () => {
  assert.deepEqual(Core.classify("KXMISENATE"), { type: "senate", st: "MI", special: false, pref: 0 });
  assert.equal(Core.classify("KXMESENATEPERSON").st, "ME");
  assert.deepEqual(Core.classify("KXGOVCA"), { type: "gov", st: "CA", pref: 0 });
  assert.deepEqual(Core.classify("KXCA11PERSON"), { type: "house", st: "CA", dist: 11, pref: 0 });
  assert.equal(Core.classify("KXALASKAHOUSE").dist, 0);
  assert.equal(Core.seriesKey(Core.classify("KXMISENATE")), Core.seriesKey(Core.classify("SENATEMI")));
  for (const t of ["KXGOVCANOMD", "KXGOVWINS", "KXSAOPAULOSENATE", "KXSENATEILD", "KXGOVSENDIFF"]) assert.equal(Core.classify(t), null, t);
});

test("coverage check flags race-like series we don't recognize, not side bets", () => {
  assert.ok(Core.untrackedRace("KXSENATERACE", "Senate Race Winner?"), "an unknown race series gets flagged");
  assert.equal(Core.untrackedRace("KXHOUSERACE", "House Race Winner?"), false, "now recognized");
  for (const [t, ti] of [["SENATETX", "Texas Senate race"], ["KXSENATEILD", "ILD"], ["SENATEPARTYTN", "Tennessee Senate race"],
    ["KXSENATENYD", "Democratic nominee for New York Senate"], ["HOUSEMOV", "House margin of victory"], ["KXJAPANHOUSE", "Japan House of Representatives"],
    ["KXGOVSENSPLIT", "Senate-Governor split results"], ["KXMISENATE", "Michigan Senate winner? (Person)"]])
    assert.equal(Core.untrackedRace(t, ti), false, t);
});

test("a multi-district series is read district by district", () => {
  const meta = { series: "KXHOUSERACE", ...Core.classify("KXHOUSERACE") };
  assert.deepEqual(Core.eventMeta(meta, { event_ticker: "KXHOUSERACE-NC03-26" }), { series: "KXHOUSERACE", type: "house", st: "NC", dist: 3, special: false, pref: 1.5, multi: true });
  assert.equal(Core.eventMeta(meta, { event_ticker: "KXHOUSERACE-AKAL-26" }).dist, 0);
  assert.equal(Core.eventMeta(meta, { event_ticker: "KXHOUSERACE-XX03-26" }), null, "unknown state");
  assert.ok(Core.is2026(meta, { event_ticker: "KXHOUSERACE-NC03-26" }));
  assert.equal(Core.seriesKey(Core.eventMeta(meta, { event_ticker: "KXHOUSERACE-PA07-26" })), Core.seriesKey(Core.classify("HOUSEPA7")), "same race as the dedicated series");
});

test("the 2026 seat list: 435 House, 35 Senate, 36 governors, and what counts as a seat", () => {
  assert.equal(Object.values(Core.SEATS2026.house).reduce((a, b) => a + b, 0), 435);
  assert.equal(Core.SEATS2026.senate.length, 35);
  assert.equal(Core.SEATS2026.gov.length, 36);
  assert.ok(Core.isSeat({ type: "house", st: "PA", dist: 17 }));
  assert.ok(!Core.isSeat({ type: "house", st: "PA", dist: 18 }), "no PA-18");
  assert.ok(Core.isSeat({ type: "house", st: "AK", dist: 0 }), "at large");
  assert.ok(!Core.isSeat({ type: "house", st: "AK", dist: 1 }));
  assert.ok(!Core.isSeat({ type: "senate", st: "CA" }), "no California Senate race in 2026");
  assert.ok(!Core.isSeat({ type: "gov", st: "KY" }), "Kentucky governor is 2027");
});
