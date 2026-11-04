// "Still Counting": open races as a board, with what moved since the last refresh
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadPage, defaultBoard, twoParty, waitFor } = require("./helpers.js");

function board() {
  const b = defaultBoard();
  b.events.HOUSEAZ2 = [twoParty("HOUSEAZ2-26", "Jonathan Nez", "Eli Crane", 0.81)];
  b.events.HOUSECA23 = [twoParty("HOUSECA23-26", "D", "Jay Obernolte", 0.34)];
  const called = twoParty("SENATENC-26", "Roy Cooper", "Michael Whatley", 0.99);
  called.markets.forEach((m) => { m.status = "determined"; m.result = m.ticker.endsWith("-D") ? "yes" : "no"; });
  b.events.SENATENC = [called];
  return b;
}
const setOdds = (b, series, pD) => b.events[series][0].markets.forEach((m) => {
  const v = m.ticker.endsWith("-D") ? pD : 1 - pD;
  m.yes_bid_dollars = (v - 0.005).toFixed(4); m.yes_ask_dollars = (v + 0.005).toFixed(4); m.last_price_dollars = v.toFixed(4);
});
const colOf = (pg, id) => pg.d.querySelector(`.rc[data-id="${id}"]`)?.closest(".col")?.dataset.col;

test("Still Counting: open races sit in the column their odds put them in; called races are tallied", async (t) => {
  const b = board();
  const pg = loadPage({ file: "counting.html", board: b });
  t.after(() => pg.close());
  await waitFor(() => pg.d.querySelector(".rc[data-id]"), { what: "board", timeout: 15000 });
  assert.equal(colOf(pg, "HOUSEAZ2-26"), "d", "Nez 81%: leaning Democratic");
  assert.equal(colOf(pg, "HOUSECA23-26"), "t", "Obernolte 66%: toss-up");
  assert.equal(colOf(pg, "HOUSEAKAL-26"), "t", "Begich 60%: toss-up");
  assert.equal(colOf(pg, "GOVPARTYAZ-26"), "d");
  assert.ok(!pg.d.querySelector('.rc[data-id="SENATENC-26"]'), "called race isn't on the board");
  assert.match(pg.text("#tSen"), /D 35 · R 31/, "34 not up + Cooper; 31 not up");
});

test("Still Counting: after a refresh, moves are listed and a card that crossed columns is marked", async (t) => {
  const b = board();
  const pg = loadPage({ file: "counting.html", board: b });
  t.after(() => pg.close());
  await waitFor(() => pg.d.querySelector(".rc[data-id]"), { what: "board", timeout: 15000 });
  setOdds(b, "HOUSEAZ2", 0.68);   // Nez slips into toss-up
  setOdds(b, "HOUSECA23", 0.30);  // Obernolte firms up a bit, still toss-up
  pg.d.getElementById("refresh").click();
  await waitFor(() => /moved since/i.test(pg.text("#movedHead")) && pg.d.querySelector(".mchip"), { what: "moves", timeout: 15000 });
  assert.match(pg.text("#movedList"), /AZ-2 Leaning Democratic → Toss-up R \+13\.0/);
  assert.match(pg.text("#movedList"), /CA-23 R \+4\.0/);
  assert.equal(colOf(pg, "HOUSEAZ2-26"), "t");
  const card = pg.d.querySelector('.rc[data-id="HOUSEAZ2-26"]');
  assert.match(card.className, /crossed/);
  assert.match(card.textContent, /From Democratic/);
});
