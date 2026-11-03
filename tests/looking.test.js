// "How We Looking": the early-tells chart read from live odds and margin markets.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, defaultBoard, twoParty, market, waitFor } = require("./helpers.js");

// Brackets like the real margin markets: "Name, 0-2%" ... "Name, ≥8%"
function brackets(ticker, dName, rName, dist) {
  return { event_ticker: ticker, markets: dist.map(([who, rng, p], i) => market(`${ticker}-${i}`, `${who === "D" ? dName : rName}, ${rng}`, p)) };
}
function board() {
  const b = defaultBoard();
  const E = b.events;
  // Senate races from the chart
  E.SENATENC = [twoParty("SENATENC-26", "Roy Cooper", "Michael Whatley", 0.95)];
  E.SENATEFL = [twoParty("SENATEFL-26", "Josh Nixon", "Ashley Moody", 0.2)];
  E.SENATESC = [twoParty("SENATESC-26", "Annie Andrews", "Darline Graham", 0.3)];
  E.SENATEMI = [twoParty("SENATEMI-26", "Abdul El-Sayed", "Mike Rogers", 0.71)];
  E.GOVPARTYTX = [twoParty("GOVPARTYTX-26", "Gina Hinojosa", "Greg Abbott", 0.3)];
  E.GOVPARTYFL = [twoParty("GOVPARTYFL-26", "David Jolly", "Byron Donalds", 0.04)];
  // House districts from the chart: tide races mostly D, wave races split, tsunami R
  E.HOUSEPA8 = [twoParty("HOUSEPA8-26", "Janet Belarmino", "Rob Bresnahan", 0.62)];
  E.HOUSEMI7 = [twoParty("HOUSEMI7-26", "D", "Tom Barrett", 0.58)];
  E.HOUSENJ7 = [twoParty("HOUSENJ7-26", "D", "Tom Kean", 0.4)];
  E.HOUSEOH10 = [twoParty("HOUSEOH10-26", "D", "Mike Turner", 0.55)];
  E.HOUSEVA1 = [twoParty("HOUSEVA1-26", "D", "Rob Wittman", 0.3)];
  E.HOUSENJ2 = [twoParty("HOUSENJ2-26", "D", "Jeff Van Drew", 0.1)];
  E.HOUSEVA7 = [twoParty("HOUSEVA7-26", "Eugene Vindman", "R", 0.96)];
  E.HOUSEPA10 = [twoParty("HOUSEPA10-26", "Janelle Stelson", "Scott Perry", 0.6)];
  // Margin markets
  E.KXGENERALMOV = [
    brackets("KXGENERALMOV-SENATETX-26", "James Talarico", "Ken Paxton", [["D", "0-2%", 0.18], ["D", "2-4%", 0.23], ["D", "4-6%", 0.19], ["D", "≥6%", 0.12], ["R", "0-2%", 0.17], ["R", "2-4%", 0.08], ["R", "≥4%", 0.03]]),
    brackets("KXGENERALMOV-GOVPARTYTX-26", "Gina Hinojosa", "Greg Abbott", [["R", "0-2%", 0.18], ["R", "2-4%", 0.2], ["R", "4-6%", 0.16], ["R", "≥6%", 0.16], ["D", "0-2%", 0.17], ["D", "≥2%", 0.13]]),
    brackets("KXGENERALMOV-SENATESC-26", "Annie Andrews", "Darline Graham", [["R", "0-2%", 0.19], ["R", "2-4%", 0.18], ["R", "4-6%", 0.14], ["R", "≥6%", 0.2], ["D", "0-2%", 0.16], ["D", "≥2%", 0.13]]),
    brackets("KXGENERALMOV-SENATEMI-26", "Abdul El-Sayed", "Mike Rogers", [["D", "0-2%", 0.18], ["D", "2-4%", 0.18], ["D", "4-6%", 0.16], ["D", "≥6%", 0.2], ["R", "0-2%", 0.14], ["R", "≥2%", 0.14]]),
  ];
  E.KXMIDTERMMOV = [{ event_ticker: "KXMIDTERMMOV-NESENR", markets: [["1", 0.66], ["3", 0.6], ["5", 0.44], ["7", 0], ["9", 0.21]].map(([k, p], i) => market(`KXMIDTERMMOV-NESENR-${i}`, `Ricketts, ${k}+ pts`, p)) }];
  return b;
}
function page(t, opts = {}) { const pg = loadPage({ file: "looking.html", board: board(), ...opts }); t.after(() => pg.close()); return pg; }
const ready = (pg) => waitFor(() => /Updated/.test(pg.text("#status")) && pg.d.querySelector("#senate .srow:not(.head)"), { what: "looking page", timeout: 15000 });
const srow = (pg, st) => [...pg.d.querySelectorAll("#senate .srow")].find((r) => r.textContent.includes(st));

test("How We Looking: margin markets place each Senate race in a scenario column", async (t) => {
  const pg = page(t, { now: Date.parse("2026-11-01T20:00:00Z") });
  await ready(pg);
  const tx = srow(pg, "Texas");
  assert.match(tx.querySelector(".st-mov").textContent, /Talarico \+2\.\d/, "Talarico's market middle is about +2.3");
  assert.equal(tx.querySelector(".sc.on").textContent, "R4-D4", "Texas: Blue Tide range");
  assert.equal(srow(pg, "Michigan").querySelector(".sc.on").textContent, "D0-7");
  assert.match(srow(pg, "South Carolina").querySelector(".st-mov").textContent, /Graham \+/);
  const ne = srow(pg, "Nebraska");
  assert.match(ne.querySelector(".st-mov").textContent, /Ricketts \+4\.\d/, "ladder market: Ricketts by about 4");
  assert.equal(ne.querySelector(".sc.on").textContent, "R4-Even");
  assert.match(srow(pg, "Iowa").querySelector(".st-mov").textContent, /no margin market/);
  assert.match(srow(pg, "North Carolina").querySelector(".st-odds").textContent, /Cooper 95%✓/, "92%+ counts as won");
  assert.deepEqual(pg.errors, []);
});

test("How We Looking: House tiers count who's ahead in each tier's races", async (t) => {
  const pg = page(t, { now: Date.parse("2026-11-01T20:00:00Z") });
  await ready(pg);
  const chip = (k) => [...pg.d.querySelectorAll("#hgrid .chip")].find((c) => c.querySelector("b")?.textContent === k);
  assert.match(chip("PA-8").className, /\bD\b/);
  assert.match(chip("VA-7").className, /\bD\b.*lock/, "Vindman 96%: counted as won");
  assert.match(chip("NJ-7").className, /\bR\b/);
  assert.match(chip("PA-1").className, /none/, "no market");
  assert.match(pg.text("#vHouse"), /Tide races: Democrats ahead in 3 of 4/, "PA-8, MI-7 and NC-11 (from the default board); not NJ-7");
  assert.match(pg.text("#vHouse"), /Wave races: Democrats ahead in 1 of 2/);
  assert.match(pg.text("#vHouse .vname"), /Blue Wave/, "tide and wave both at least half");
  assert.match(pg.text("#vHouse"), /Seat-count market: Democrats 23\d/);
  const pa = [...pg.d.querySelectorAll("#hgrid .chip.test")].find((c) => /PA-7/.test(c.textContent));
  assert.match(pa.textContent, /GOP favored in 0 of 2/);
  assert.match(pg.text("#preview"), /Preview/, "before election night it says it's reading pre-election odds");
});

test("How We Looking: Senate verdict from net seats if favorites win", async (t) => {
  const pg = page(t, { now: Date.parse("2026-11-01T20:00:00Z") });
  await ready(pg);
  // Held R and D favored: TX, NC, ME, AK -> +4; held D, R favored: none in this board
  assert.match(pg.text("#vSenate"), /If every favorite wins: D \+4/);
  assert.match(pg.text("#vSenate .vname"), /Blue Wave/);
  assert.match(pg.text("#vSenate"), /Counted as won \(92%\+\): D \+1/, "only Cooper is 92%+");
});

test("How We Looking: keys tick from the odds once their time comes", async (t) => {
  // 9:30pm ET on election night
  const pg = page(t, { now: Date.parse("2026-11-04T02:30:00Z") });
  await ready(pg);
  const key = (txt) => [...pg.d.querySelectorAll("#keys .krow")].find((r) => r.textContent.includes(txt));
  assert.match(key("NC called for Cooper").querySelector(".pill").className, /yesD/);
  assert.match(key("Florida Senate still uncalled").querySelector(".pill").textContent, /Yes.*Moody 80%/);
  assert.match(key("Florida governor still uncalled").querySelector(".pill").className, /\bno\b/, "Donalds 96%: called");
  assert.match(key("Paxton trails Abbott").querySelector(".pill").textContent, /Yes/, "Paxton about R+... vs Abbott further ahead");
  assert.match(key("Abbott uncalled").querySelector(".pill").className, /wait/, "11pm key not yet");
  assert.match(key("El-Sayed lags").querySelector(".pill").textContent, /Watch/);
  assert.ok(!pg.d.querySelector("#preview:not([hidden])"), "no preview banner on election night");
  assert.deepEqual(pg.errors, []);
});

test("How We Looking: tapping a race opens the live tracker's chart over the page", async (t) => {
  const pg = page(t, { now: Date.parse("2026-11-01T20:00:00Z") });
  await ready(pg);
  [...pg.d.querySelectorAll("#senate .srow")].find((r) => r.textContent.includes("Texas")).click();
  const f = pg.d.getElementById("raceFrame");
  assert.ok(f, "overlay opened");
  assert.match(f.getAttribute("src"), /\?embed=1&race=SENATETX-26$/);
  pg.w.dispatchEvent(new pg.w.MessageEvent("message", { data: { type: "et-close-race" }, origin: pg.w.location.origin }));
  assert.ok(!pg.d.getElementById("raceFrame"), "closed when the chart closes");
  const chip = [...pg.d.querySelectorAll("#hgrid .chip[data-open]")].find((c) => c.querySelector("b").textContent === "PA-8");
  chip.click();
  assert.match(pg.d.getElementById("raceFrame").getAttribute("src"), /race=HOUSEPA8-26/);
});

test("How We Looking: FL-12 and FL-16 sit in the 7pm Blue Tsunami column", async (t) => {
  const b = board();
  b.events.HOUSEFL12 = [twoParty("HOUSEFL12-26", "D", "R", 0.16)];
  b.events.HOUSEFL16 = [twoParty("HOUSEFL16-26", "D", "R", 0.25)];
  const pg = page(t, { board: b, now: Date.parse("2026-11-01T20:00:00Z") });
  await ready(pg);
  const cells = [...pg.d.querySelectorAll("#hgrid .cell.tsunami")];
  const sevenPm = cells.find((c) => /FL-27/.test(c.textContent));
  assert.match(sevenPm.textContent, /FL-12.*R 84%/);
  assert.match(sevenPm.textContent, /FL-16.*R 75%/);
  assert.ok(!pg.d.getElementById("ladder"), "no separate ladder section");
});

test("How We Looking: TV mode shows one slide at a time and taps move through them", async (t) => {
  const pg = page(t, { now: Date.parse("2026-11-01T20:00:00Z"), url: "https://tracker.test/looking.html?tv=1" });
  await ready(pg);
  assert.ok(pg.d.documentElement.classList.contains("tv"));
  const on = () => [...pg.d.querySelectorAll(".slide.on")].map((el) => el.dataset.slide);
  assert.deepEqual(on(), ["Overview"]);
  const tap = (x) => pg.d.body.dispatchEvent(new pg.w.MouseEvent("click", { bubbles: true, clientX: x, clientY: 300 }));
  tap(pg.w.innerWidth * 0.9);
  assert.deepEqual(on(), ["House"]);
  tap(pg.w.innerWidth * 0.1);
  assert.deepEqual(on(), ["Overview"]);
  tap(pg.w.innerWidth * 0.5);
  assert.match(pg.text("#tvPause"), /Play/, "middle tap pauses");
  pg.d.getElementById("tvExit").click();
  assert.ok(!pg.d.documentElement.classList.contains("tv"));
});

test("How We Looking: movers come from the server's trend history", async (t) => {
  const tr = require("../api/_trends.js");
  const H = require("./helpers.js");
  const pg = page(t, { snapshot: "slow" });
  const now = Date.now();
  for (let m = 90; m >= 1; m--) await tr.record([{ ev: H.twoParty("SENATETX-26", "James Talarico", "Ken Paxton", m > 30 ? 0.6 : 0.68) }], now - m * 60e3);
  await waitFor(() => pg.log.includes("PAGE /api/snapshot"), { what: "snapshot request" });
  pg.release();
  await ready(pg);
  await waitFor(() => pg.d.querySelector("#movers .mvrow[data-open]"), { what: "movers", timeout: 10000 });
  const row = pg.d.querySelector('#movers .mvrow[data-open="SENATETX-26"]');
  assert.match(row.textContent, /Texas Senate.*Talarico.*D \+8\.0/);
});
