// The page itself, run in a headless browser against the fake Kalshi.
const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultBoard, twoParty, loadPage, waitFor, loaded } = require("./helpers.js");

function page(t, opts) {
  const pg = loadPage(opts);
  t.after(() => pg.close());
  return pg;
}
const noErrors = (pg) => assert.deepEqual(pg.errors, [], "no script errors");

test("loads every race from one snapshot call", async (t) => {
  const pg = page(t);
  await loaded(pg);
  assert.equal(pg.log.filter((l) => l === "PAGE /api/snapshot").length, 1);
  const pageCalls = pg.log.filter((l) => l.startsWith("PAGE /api/kalshi "));
  assert.ok(pageCalls.every((l) => /candlesticks$/.test(l)), "the page only asks for trend history itself, never for races");
  assert.match(pg.text("#updated"), /fast/);
  assert.match(pg.text("#ctlS"), /67%/);
  noErrors(pg);
});

test("shows one row per race, 2026 only", async (t) => {
  const pg = page(t);
  await loaded(pg);
  const ids = pg.rows().map((r) => r.dataset.id);
  assert.equal(ids.filter((id) => id.startsWith("SENATEAK") || id.startsWith("KXSENATEAK")).length, 1, "Alaska appears once");
  assert.ok(ids.includes("SENATEAK-26"), "busy Alaska market wins over the thin one");
  assert.ok(!ids.some((id) => id.includes("KY")), "Kentucky 2027 hidden");
  assert.ok(!ids.some((id) => id.includes("NYCCOUNCIL")));
});

test("reads party tags in every Kalshi style (NC-11 uses DEM/GOP)", async (t) => {
  const pg = page(t);
  await loaded(pg);
  const nc = pg.row("KXHOUSENC11-26");
  assert.ok(nc.querySelector(".oddslab .d").textContent.includes("Jamie Ager"));
  assert.ok(nc.querySelector(".oddslab .r2").textContent.includes("Jennifer Balkcom"));
});

test("three-way race: Nebraska shows the independent and flags an I pickup when he leads", async (t) => {
  const board = defaultBoard();
  const pg = page(t, { board });
  await loaded(pg);
  const ne = () => pg.row("SENATENE-26").textContent;
  assert.match(ne(), /Pete Ricketts 7\d%/);
  assert.match(ne(), /Dan Osborn/);
  assert.doesNotMatch(ne(), /Cindy Burbank/, "the 0% Democrat isn't headlined");
  // Osborn takes the lead
  const m = board.events.SENATENE[0].markets;
  Object.assign(m[0], { yes_bid_dollars: "0.3950", yes_ask_dollars: "0.4050", last_price_dollars: "0.4000" });
  Object.assign(m[1], { yes_bid_dollars: "0.6050", yes_ask_dollars: "0.6150", last_price_dollars: "0.6100" });
  pg.d.getElementById("refresh").click();
  await waitFor(() => /I pickup/.test(ne()), { what: "I pickup" });
});

test("seat holders and pickups", async (t) => {
  const pg = page(t);
  await loaded(pg);
  assert.match(pg.row("SENATETX-26").textContent, /D pickup/, "Texas held by R, D favored");
  assert.doesNotMatch(pg.row("SENATEGA-26").textContent, /pickup/, "Georgia held by D, D favored");
  assert.match(pg.row("KXHOUSENC11-26").textContent, /New map/, "redrawn state has no holder");
});

test("balance of power: Senate adds to 100, House uses the seat market", async (t) => {
  const pg = page(t);
  await loaded(pg);
  const nums = [...pg.d.querySelectorAll("#balS .baltally b")].map((b) => parseInt(b.textContent));
  assert.equal(nums.reduce((a, b) => a + b, 0), 100, "Senate seats add to 100");
  const widths = [...pg.d.querySelectorAll("#balS .seatbar i")].reduce((a, i) => a + parseFloat(i.style.width), 0);
  assert.equal(Math.round(widths), 100, "Senate bar fills exactly");
  assert.match(pg.text("#balH"), /23\dDEM/);
  assert.match(pg.text("#balH"), /218/);
});

test("toss-up chip opens the race chart", async (t) => {
  const pg = page(t);
  await loaded(pg);
  const chip = pg.d.querySelector('#balS [data-open="SENATEME-26"]');
  assert.ok(chip, "Maine listed as a toss-up");
  chip.click();
  await waitFor(() => pg.d.getElementById("sheetTitle"), { what: "chart sheet" });
  assert.equal(pg.text("#sheetTitle"), "Maine");
  await waitFor(() => !/Loading/.test(pg.text("#chartbox")), { what: "chart loaded" });
});

test("falls back to per-race loading when the snapshot is down", async (t) => {
  const pg = page(t, { snapshot: "fail" });
  await loaded(pg);
  assert.ok(pg.log.some((l) => l.startsWith("PAGE /api/kalshi /events")), "used the relay for races");
  assert.ok(pg.row("SENATETX-26"));
  assert.ok(!pg.rows().some((r) => r.dataset.id.includes("KY")), "still filters 2027");
  assert.match(pg.text("#balH"), /DEM/, "House seat market still loads");
  noErrors(pg);
});

test("shows saved odds instantly, then updates", async (t) => {
  const first = loadPage();
  await loaded(first);
  const saved = JSON.parse(first.w.localStorage.getItem("et.snap"));
  first.close();
  assert.ok(saved && saved.out.length > 5, "odds were saved on the device");

  const pg = page(t, { snapshot: "slow", storage: { "et.snap": saved } });
  await waitFor(() => pg.rows().length > 0, { what: "saved rows" });
  assert.match(pg.text("#updated"), /Showing saved odds/);
  pg.release();
  await waitFor(() => /Updated/.test(pg.text("#updated")), { what: "fresh odds" });
  noErrors(pg);
});

test("What changed: lead flip and 90% crossing, nothing for flat races", async (t) => {
  const board = defaultBoard();
  const now = Math.floor(Date.now() / 1000), H = 3600;
  // Maine flips 3 hours ago; Georgia passes 90% 8 hours ago; Texas is flat.
  board.events.SENATEME = [twoParty("SENATEME-26", "Graham Platner", "Susan Collins", 0.56)];
  board.events.SENATEGA = [twoParty("SENATEGA-26", "Jon Ossoff", "Mike Collins", 0.92)];
  const paths = { SENATEME: (t) => (t > now - 3 * H ? 0.56 : 0.44), SENATEGA: (t) => (t > now - 8 * H ? 0.92 : 0.84), SENATETX: () => 0.68 };
  board.candles = (tk, t) => {
    const s = Object.keys(paths).find((k) => tk.startsWith(k + "-"));
    if (!s) return null;
    const v = paths[s](t);
    return tk.endsWith("-D") ? v : 1 - v;
  };
  const pg = page(t, { board });
  await loaded(pg);
  await waitFor(() => /Maine Sen/.test(pg.text("#feedList")) && /Georgia Sen/.test(pg.text("#feedList")), { what: "feed entries", timeout: 12000 });
  const feed = pg.text("#feedList");
  assert.match(feed, /Maine Sen: lead flipped to Graham Platner/);
  assert.match(feed, /Georgia Sen: Jon Ossoff passed 90%/);
  assert.doesNotMatch(feed, /Texas Sen/);
  assert.equal(pg.d.querySelectorAll("#feedList .fe").length, 2, "flip and its move are one line each");
  noErrors(pg);
});

test("Move over: window choice drives the move column; since last look shows the time", async (t) => {
  const pg = page(t, { storage: { "et.lastSeen": Date.now() - 5 * 3600e3 } });
  await loaded(pg);
  pg.d.querySelector('#winSeg [data-v="6h"]').click();
  assert.equal(pg.text("#winHead"), "6h");
  pg.d.querySelector('#winSeg [data-v="last"]').click();
  assert.match(pg.text("#winHead"), /^Since (\w{3} )?\d/);
  assert.match(pg.text("#nMoveLab"), /since/i);
  noErrors(pg);
});

test("tapping a race opens its chart", async (t) => {
  const board = defaultBoard();
  board.candles = (tk) => (tk.endsWith("-D") ? 0.6 : 0.4);
  const pg = page(t, { board });
  await loaded(pg);
  pg.row("SENATETX-26").click();
  await waitFor(() => pg.d.querySelectorAll("#chartbox path").length === 2, { what: "chart lines" });
  assert.equal(pg.text("#sheetTitle"), "Texas");
  pg.d.getElementById("sheetClose").click();
  assert.ok(!pg.d.getElementById("sheetBg"));
});

test("moves are labeled by who gained (D +, R +, I +), never a minus sign", async (t) => {
  const { market } = require("./helpers.js");
  const board = defaultBoard();
  // 24 hours ago: Talarico 75% -> now 68% (R +7); Ossoff 70% -> 80% (D +10); Osborn 20% -> 29% (I +)
  board.events.SENATETX = [{ event_ticker: "SENATETX-26", markets: [market("SENATETX-26-D", "James Talarico", 0.68, { prev: 0.75 }), market("SENATETX-26-R", "Ken Paxton", 0.32, { prev: 0.25 })] }];
  board.events.SENATEGA = [{ event_ticker: "SENATEGA-26", markets: [market("SENATEGA-26-D", "Jon Ossoff", 0.8, { prev: 0.7 }), market("SENATEGA-26-R", "Mike Collins", 0.2, { prev: 0.3 })] }];
  board.events.SENATENE = [{ event_ticker: "SENATENE-26", markets: [market("SENATENE-26-R", "Pete Ricketts", 0.72, { prev: 0.8 }), market("SENATENE-26-I", "Dan Osborn", 0.29, { prev: 0.2 }), market("SENATENE-26-D", "Cindy Burbank", 0.003)] }];
  const pg = page(t, { board, storage: { "et.ui": { sort: "key", type: "all", compet: false, auto: false, win: "24h" } } });
  await loaded(pg);
  const moveCell = (id) => pg.row(id).querySelectorAll(".c")[1].textContent.trim();
  assert.equal(moveCell("SENATETX-26"), "R +7.0");
  assert.equal(moveCell("SENATEGA-26"), "D +10");
  assert.match(moveCell("SENATENE-26"), /^I \+/);
  assert.doesNotMatch(pg.d.getElementById("table").textContent, /−\d/, "no minus signs in moves");
  noErrors(pg);
});

test("trend lines cover the same window as the move column", async (t) => {
  const board = defaultBoard();
  const now = Math.floor(Date.now() / 1000);
  board.candles = (tk, ts) => { const v = 0.6 + 0.1 * Math.sin(ts / 7000); return tk.endsWith("-D") ? v : 1 - v; };
  const pg = page(t, { board, storage: { "et.ui": { sort: "key", type: "all", compet: false, auto: false, win: "1h" } } });
  await loaded(pg);
  await waitFor(() => !/filling in trends/.test(pg.text("#updated")) && (pg.w.localStorage.getItem("et.history") || "").length > 1000, { what: "history filled", timeout: 15000 });
  const span = () => {
    const pts = pg.row("SENATETX-26").querySelector(".spark polyline").getAttribute("points").split(" ");
    return pts.length;
  };
  const oneHour = span();
  pg.d.querySelector('#winSeg [data-v="24h"]').click();
  await waitFor(() => span() > oneHour * 2, { what: "longer trend line for 24h" });
  assert.match(pg.text("#trendHead"), /24h/);
  noErrors(pg);
});

test("move column fills in for quiet and thin races after history loads", async (t) => {
  const { market } = require("./helpers.js");
  const board = defaultBoard();
  const now = Math.floor(Date.now() / 1000), H = 3600;
  // PA-7 traded once, 5 hours ago, at 80% (now 85%); AK-AL is thin; NC-11 had no trades at all today.
  board.events.HOUSEAKAL = [{ event_ticker: "HOUSEAKAL-26", markets: [market("HOUSEAKAL-26-D", "Mary Peltola", 0.4, { vol24: 500 }), market("HOUSEAKAL-26-R", "Nick Begich", 0.6, { vol24: 500 })] }];
  board.events.KXHOUSENC11 = [{ event_ticker: "KXHOUSENC11-26", markets: [market("KXHOUSENC11-26-DEM", "Jamie Ager", 0.87, { vol24: 0 }), market("KXHOUSENC11-26-GOP", "Jennifer Balkcom", 0.13, { vol24: 0 })] }];
  board.candles = (tk, ts) => {
    if (tk.startsWith("HOUSEPA7-26")) { const hit = Math.abs(ts - (now - 5 * H)) < 61 || Math.abs(ts - Math.floor((now - 5 * H) / H) * H) < 1; if (!hit) return null; return tk.endsWith("-D") ? 0.8 : 0.2; }
    if (tk.startsWith("HOUSEAKAL-26")) return tk.endsWith("-D") ? 0.35 : 0.65;
    return null;
  };
  const pg = page(t, { board, storage: { "et.ui": { sort: "key", type: "all", compet: false, auto: false, win: "1h" } } });
  await loaded(pg);
  const moveCell = (id) => pg.row(id).querySelectorAll(".c")[1].textContent.trim();
  await waitFor(() => !/filling in trends/.test(pg.text("#updated")) && moveCell("HOUSEAKAL-26") !== "–", { what: "history filled", timeout: 15000 });
  assert.notEqual(moveCell("HOUSEPA7-26"), "–", "quiet race: last trade carried forward");
  assert.equal(moveCell("HOUSEAKAL-26"), "D +5.0", "thin race filled from its history");
  assert.equal(moveCell("KXHOUSENC11-26"), "0", "no trades today: no move, no lookup needed");
  pg.d.querySelector('#winSeg [data-v="6h"]').click();
  assert.equal(moveCell("HOUSEPA7-26"), "D +5.0", "6h move uses the price before the last trade");
  noErrors(pg);
});

test("House rows show their district's 2024 result and holder; Missouri and Virginia use old maps", async (t) => {
  const board = defaultBoard();
  board.events.HOUSEVA2 = [twoParty("HOUSEVA2-26", "Missy Cotter Smasal", "Jen Kiggans", 0.55)];
  board.events.HOUSEFL13 = [twoParty("HOUSEFL13-26", "D", "Anna Paulina Luna", 0.2)];
  board.events.KXHOUSEMO5 = [twoParty("KXHOUSEMO5-26", "Emanuel Cleaver", "R", 0.9)];
  const pg = page(t, { board });
  await loaded(pg);
  const cells = (id) => [...pg.row(id).querySelectorAll(".c")].map((c) => c.textContent.trim());
  assert.equal(cells("HOUSEPA7-26")[5], "R+3", "PA-7 Trump '24 by district, not statewide");
  assert.equal(pg.row("HOUSEPA7-26").querySelector(".held").textContent, "R");
  assert.equal(pg.row("HOUSEVA2-26").querySelector(".held").textContent, "R", "Virginia keeps its old map, so the holder is known");
  assert.match(pg.row("HOUSEVA2-26").textContent, /D pickup/);
  assert.equal(pg.row("KXHOUSEMO5-26").querySelector(".held").textContent, "D", "Missouri keeps its old map");
  assert.equal(cells("KXHOUSEMO5-26")[5], "D+23");
  assert.match(pg.row("HOUSEFL13-26").textContent, /New map/, "Florida redrew");
  assert.equal(cells("HOUSEFL13-26")[5], "R+13", "Florida uses the recalculated new-line result");
  assert.equal(cells("KXHOUSENC11-26")[5], "–", "no recalculated result for North Carolina yet");
  noErrors(pg);
});

test("?check adds a report of the feed next to Kalshi's 24-hour-ago prices", async (t) => {
  const board = defaultBoard();
  board.candles = (tk) => (tk.endsWith("-D") ? 0.6 : 0.4);
  const pg = loadPageAt(t, "https://tracker.test/?check", { board });
  await loaded(pg);
  await waitFor(() => !pg.d.getElementById("checkBox").hidden, { what: "check box" });
  pg.d.getElementById("checkBtn").click();
  await waitFor(() => pg.d.getElementById("checkOut").value.length > 100, { what: "report" });
  const rep = JSON.parse(pg.d.getElementById("checkOut").value);
  assert.equal(rep.v, "check1");
  const tx = rep.races.find((r) => r.id === "SENATETX-26");
  assert.ok(tx && typeof tx.now === "number" && typeof tx.k24 === "number");
  assert.ok(Array.isArray(rep.feed));
  noErrors(pg);
});
function loadPageAt(t, url, opts) { const pg = loadPage({ ...opts, url }); t.after(() => pg.close()); return pg; }

test("the Since last look button keeps its own label whatever window is selected", async (t) => {
  const pg = page(t, { storage: { "et.lastSeen": Date.now() - 5 * 3600e3, "et.ui": { sort: "movers", type: "all", compet: false, auto: false, win: "24h" } } });
  await loaded(pg);
  assert.match(pg.text("#winLastBtn"), /^Since/);
  pg.d.querySelector('#winSeg [data-v="1h"]').click();
  assert.match(pg.text("#winLastBtn"), /^Since/);
});
