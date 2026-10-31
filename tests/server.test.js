// The server functions: catalog building, price refresh, snapshot and relay responses.
const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultBoard, useFakeKalshi, callHandler } = require("./helpers.js");
const lib = require("../api/_lib.js");

function withBoard(board, fn) {
  return async () => {
    const log = [];
    const restore = useFakeKalshi(board, log);
    try { await fn(log); } finally { restore(); }
  };
}

test("catalog: one series per race, 2026 only, seat market included", withBoard(defaultBoard(), async () => {
  const cat = await lib.buildCatalog();
  const series = cat.races.map((r) => r.meta.series).sort();
  assert.ok(series.includes("SENATEAK"), "party-style Alaska series kept");
  assert.ok(!series.includes("KXSENATEAK"), "lower-preference Alaska series dropped");
  assert.ok(!series.includes("GOVPARTYKY"), "2027 Kentucky race dropped");
  assert.ok(!series.includes("SENATEOH"), "series with no 2026 event dropped");
  assert.ok(!series.includes("KXNYCCOUNCIL8"), "untracked series dropped");
  assert.ok(series.includes("KXHOUSENC11"));
  assert.equal(cat.seats.event_ticker, "KXDHOUSESEATS-27");
  const ctlS = cat.races.find((r) => r.meta.type === "ctlS");
  assert.deepEqual(ctlS.events.map((e) => e.event_ticker), ["CONTROLS-2026"], "2028 control market dropped");
  assert.ok(!("rules_primary" in cat.races[0].events[0].markets[0]), "markets are slimmed");
}));

test("catalog: refuses to publish a mostly-failed build", async () => {
  const board = defaultBoard();
  board.fail = (p) => p === "/events";
  const restore = useFakeKalshi(board, []);
  try { await assert.rejects(lib.buildCatalog(), /incomplete/); } finally { restore(); }
});

test("prices: batched by ticker when Kalshi supports it", withBoard(defaultBoard(), async (log) => {
  const board = defaultBoard();
  const cat = await lib.buildCatalog();
  log.length = 0;
  const fresh = await lib.refreshPrices(cat);
  assert.equal(fresh.mode, "batch");
  assert.ok(log.every((l) => l.startsWith("/markets?")), "only batch calls");
  assert.ok(log.length <= 3);
  assert.ok(fresh.seats.markets.length > 5);
}));

test("prices: falls back to per-race lookups when a batch comes back short", async () => {
  const board = defaultBoard();
  const log = [];
  const restore = useFakeKalshi(board, log);
  try {
    const cat = await lib.buildCatalog();
    board.noBatch = true;
    board.events.SENATETX = [require("./helpers.js").twoParty("SENATETX-26", "James Talarico", "Ken Paxton", 0.4)];
    const fresh = await lib.refreshPrices(cat);
    assert.equal(fresh.mode, "sweep");
    const tx = fresh.races.find((r) => r.meta.series === "SENATETX").events[0];
    assert.equal(tx.markets.find((m) => m.ticker.endsWith("-D")).last_price_dollars, "0.4000");
  } finally { restore(); }
});

test("snapshot endpoint: one response with every race, shared for 15 seconds", withBoard(defaultBoard(), async () => {
  const res = await callHandler(require("../api/snapshot.js"));
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["cache-control"], /s-maxage=15/);
  assert.ok(res.body.races.length >= 10);
  assert.ok(res.body.races.every((r) => r.meta && r.ev && r.ev.event_ticker));
  assert.ok(res.body.seats);
}));

test("snapshot endpoint: reports an error rather than caching junk", async () => {
  const board = defaultBoard();
  board.fail = () => true;
  const restore = useFakeKalshi(board, []);
  try {
    const res = await callHandler(require("../api/snapshot.js"));
    assert.equal(res.statusCode, 502);
    assert.match(res.headers["cache-control"], /no-store/);
  } finally { restore(); }
});

test("catalog endpoint: cached for an hour, refreshed in the background", withBoard(defaultBoard(), async () => {
  const res = await callHandler(require("../api/catalog.js"));
  assert.equal(res.statusCode, 200);
  assert.match(res.headers["cache-control"], /s-maxage=3600/);
  assert.match(res.headers["cache-control"], /stale-while-revalidate/);
}));

test("relay: passes allowed read-only paths, refuses others", withBoard(defaultBoard(), async () => {
  const relay = require("../api/kalshi.js");
  const ok = await callHandler(relay, { path: "/events?series_ticker=SENATETX&with_nested_markets=true" });
  assert.equal(ok.statusCode, 200);
  assert.match(String(ok.body), /SENATETX-26/);
  const bad = await callHandler(relay, { path: "/portfolio/balance" });
  assert.equal(bad.statusCode, 404);
}));

test("catalog: a lookup Kalshi refuses at first is retried, so Texas isn't dropped", async () => {
  const board = defaultBoard();
  let refusals = 0;
  board.fail = (p, u) => p === "/events" && u.searchParams.get("series_ticker") === "SENATETX" && refusals++ < 5;
  board.failStatus = 429;
  const restore = useFakeKalshi(board, []);
  try {
    const cat = await lib.buildCatalog();
    assert.ok(cat.races.some((r) => r.meta.series === "SENATETX"), "Texas present after retry");
    assert.equal(cat.failed, 0);
  } finally { restore(); }
});

test("catalog: never publishes a list missing a Senate race", async () => {
  const board = defaultBoard();
  board.fail = (p, u) => p === "/events" && u.searchParams.get("series_ticker") === "SENATETX";
  board.failStatus = 429;
  const restore = useFakeKalshi(board, []);
  try { await assert.rejects(lib.buildCatalog(), /incomplete.*SENATETX/); } finally { restore(); }
});

test("catalog: person markets fill in only when a race has no party market", async () => {
  const { twoParty } = require("./helpers.js");
  const board = defaultBoard();
  board.events.KXGOVCA = [{ event_ticker: "KXGOVCA-26", markets: [require("./helpers.js").market("KXGOVCA-26-XB", "Xavier Becerra", 0.55), require("./helpers.js").market("KXGOVCA-26-KP", "Katie Porter", 0.45)] }];
  board.events.KXMISENATE = [{ event_ticker: "KXMISENATE-26", markets: [require("./helpers.js").market("KXMISENATE-26-MMCM", "Mallory McMorrow", 0.5)] }];
  board.events.SENATEMI = [twoParty("SENATEMI-26", "Abdul El-Sayed", "Mike Rogers", 0.7)];
  board.events.KXSENATERACE = [{ event_ticker: "KXSENATERACE-26", markets: [] }];
  board.titles = { KXSENATERACE: "Senate Race Winner?" };
  const restore = useFakeKalshi(board, []);
  try {
    const cat = await lib.buildCatalog();
    const series = cat.races.map((r) => r.meta.series);
    assert.ok(series.includes("KXGOVCA"), "no party market for California governor: person market used");
    assert.ok(series.includes("SENATEMI") && !series.includes("KXMISENATE"), "party market wins in Michigan");
    assert.ok(cat.coverage.untracked.some(([t]) => t === "KXSENATERACE"), "unrecognized race series reported");
    assert.ok(cat.coverage.senate.withMarket >= 5 && cat.coverage.house.withMarket >= 3);
  } finally { restore(); }
});

test("multi-district series: each district becomes a race; a dedicated series still wins", async () => {
  const { twoParty } = require("./helpers.js");
  const board = defaultBoard();
  board.events.KXHOUSERACE = [twoParty("KXHOUSERACE-NC03-26", "Democrat X", "Greg Murphy", 0.2), twoParty("KXHOUSERACE-KS03-26", "Sharice Davids", "Republican Y", 0.7),
    twoParty("KXHOUSERACE-PA07-26", "Bob Brooks", "Ryan Mackenzie", 0.5)];
  const log = [];
  const restore = useFakeKalshi(board, log);
  try {
    const cat = await lib.buildCatalog();
    const nc = cat.races.find((r) => r.meta.st === "NC" && r.meta.dist === 3);
    assert.ok(nc && nc.meta.series === "KXHOUSERACE" && nc.events.length === 1 && nc.events[0].event_ticker === "KXHOUSERACE-NC03-26");
    assert.ok(cat.races.find((r) => r.meta.st === "KS" && r.meta.dist === 3));
    assert.equal(cat.races.find((r) => r.meta.st === "PA" && r.meta.dist === 7).meta.series, "HOUSEPA7", "dedicated PA-7 series wins");
    // Fallback sweep reads the series once and gives each district only its own event
    board.noBatch = true; log.length = 0;
    const fresh = await lib.refreshPrices(cat);
    assert.equal(fresh.mode, "sweep");
    assert.equal(log.filter((l) => l.includes("series_ticker=KXHOUSERACE")).length, 1, "read once");
    const nc2 = fresh.races.find((r) => r.meta.st === "NC" && r.meta.dist === 3);
    assert.deepEqual(nc2.events.map((e) => e.event_ticker), ["KXHOUSERACE-NC03-26"]);
  } finally { restore(); }
});

test("seat-first: busiest market wins, non-seats are ignored, missing seats are listed", async () => {
  const H = require("./helpers.js");
  const board = defaultBoard();
  // Two markets for Texas Senate: the dedicated series is quiet, a person market is busy
  board.events.SENATETX = [H.twoParty("SENATETX-26", "James Talarico", "Ken Paxton", 0.68, { vol24: 100 })];
  board.events.SENATETX[0].markets.forEach((m) => (m.volume_fp = "5000"));
  board.events.KXTXSENATE = [{ event_ticker: "KXTXSENATE-26", markets: [H.market("KXTXSENATE-26-JT", "James Talarico", 0.67), H.market("KXTXSENATE-26-KP", "Ken Paxton", 0.33)] }];
  board.events.SENATECA = [H.twoParty("SENATECA-26", "D", "R", 0.9)];          // not up in 2026
  board.events.HOUSEPA18 = [H.twoParty("HOUSEPA18-26", "D", "R", 0.5)];        // no such district
  const restore = useFakeKalshi(board, []);
  try {
    const cat = await lib.buildCatalog();
    assert.equal(cat.races.find((r) => r.meta.type === "senate" && r.meta.st === "TX").meta.series, "KXTXSENATE", "most contracts traded wins");
    assert.ok(!cat.races.some((r) => r.meta.series === "SENATECA"), "no California Senate seat");
    assert.ok(!cat.races.some((r) => r.meta.series === "HOUSEPA18"), "no PA-18");
    assert.equal(cat.races.filter((r) => r.meta.type === "senate" && r.meta.st === "AK").length, 1, "one race per seat");
    assert.equal(cat.races.find((r) => r.meta.st === "AK" && r.meta.type === "senate").events[0].event_ticker, "SENATEAK-26", "busier Alaska event");
    const cov = cat.coverage;
    assert.equal(cov.house.up, 435);
    assert.ok(cov.house.missing.includes("PA-1") && !cov.house.missing.includes("PA-7"));
    assert.equal(cov.senate.up, 35);
    assert.ok(cov.senate.missing.includes("IL"));
  } finally { restore(); }
});
