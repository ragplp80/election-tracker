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
