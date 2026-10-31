// The map: shape data integrity, coloring by odds, drill-in, and redrawn states as tiles.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadPage, waitFor, loaded, ROOT } = require("./helpers.js");
const MAP = JSON.parse(fs.readFileSync(path.join(ROOT, "map2026.json"), "utf8"));
const H24 = require("../house2024.js");

test("map data: every district in states with mapped lines, tiles for the rest", () => {
  assert.equal(Object.keys(MAP.states).length, 51, "50 states + DC");
  const byState = {};
  for (const k of Object.keys(H24.won)) { const st = k.split("-")[0]; byState[st] = (byState[st] || 0) + 1; }
  for (const [st, n] of Object.entries(byState)) {
    const keys = Object.keys(MAP.districts).filter((k) => k.startsWith(st + "-"));
    assert.equal(keys.length, n, `${st} has ${n} district shapes`);
  }
  assert.equal(Object.keys(MAP.districts).filter((k) => k.startsWith("TX-")).length, 38, "Texas: new 2026 lines");
  for (const st of H24.redrawn.filter((s) => s !== "TX")) assert.ok(MAP.tiles[st] > 0, `${st} shown as tiles`);
  assert.equal(Object.values(MAP.tiles).reduce((a, b) => a + b, 0) + Object.keys(MAP.districts).length, 435, "435 seats in all");
  for (const [k, v] of Object.entries(MAP.districts)) assert.ok(/^M[\d.-]/.test(v.d) && v.c.length === 2, k);
  assert.ok(fs.statSync(path.join(ROOT, "map2026.json")).size < 700e3, "map file stays small");
});

function page(t, opts) { const pg = loadPage(opts); t.after(() => pg.close()); return pg; }
const cls = (pg, sel) => pg.d.querySelector(sel)?.getAttribute("class") || "";

test("House map: districts colored by the favorite, gray without a market", async (t) => {
  const pg = page(t);
  await loaded(pg);
  await waitFor(() => pg.d.querySelector('#mapWrap path[data-key="PA-7"]'), { what: "map" });
  assert.match(cls(pg, '#mapWrap path[data-key="PA-7"]'), /mf-dlik/, "Brooks 85%: likely Democratic");
  assert.match(cls(pg, '#mapWrap path[data-key="AK-0"]'), /mf-rlean/, "Begich 60%: lean Republican");
  assert.match(cls(pg, '#mapWrap path[data-key="PA-1"]'), /mf-none/, "no market: gray");
  assert.match(cls(pg, '#mapWrap path[data-st="CA"]'), /mf-new/, "redrawn without shapes: hatched");
  assert.deepEqual(pg.errors, []);
});

test("Senate map: states with races colored, others marked not up", async (t) => {
  const pg = page(t);
  await loaded(pg);
  await waitFor(() => pg.d.querySelector("#mapWrap path"), { what: "map" });
  pg.d.querySelector('#mapMode [data-v="senate"]').click();
  assert.match(cls(pg, '#mapWrap path[data-st="TX"]'), /mf-dlean/, "Talarico 68%: lean Democratic");
  assert.match(cls(pg, '#mapWrap path[data-st="NE"]'), /mf-rlean/, "Ricketts vs Osborn: lean Republican");
  assert.match(cls(pg, '#mapWrap path[data-st="CA"]'), /mf-notup/, "no California Senate race in 2026");
  assert.match(cls(pg, '#mapWrap path[data-st="IL"]'), /mf-none/, "race but no market in this sample: gray");
  assert.equal(JSON.parse(pg.w.localStorage.getItem("et.ui")).mapMode, "senate", "mode remembered");
});

test("drilling into a state shows its districts and races; tapping a district opens its chart", async (t) => {
  const pg = page(t);
  await loaded(pg);
  await waitFor(() => pg.d.querySelector('#mapWrap path[data-st="PA"]'), { what: "map" });
  pg.d.querySelector('#mapWrap path[data-key="PA-12"]').dispatchEvent(new pg.w.MouseEvent("click", { bubbles: true }));
  await waitFor(() => pg.text("#mapCrumb") === "Pennsylvania", { what: "drill-in" });
  assert.equal(pg.d.querySelectorAll("#mapWrap path[data-key]").length, 17);
  assert.equal(pg.d.querySelectorAll("#mapWrap text").length, 17, "district numbers");
  assert.match(pg.text("#mapRaces"), /PA-7/);
  assert.match(pg.text("#mapRaces"), /16 districts without a betting market/);
  pg.d.querySelector('#mapWrap path[data-key="PA-7"]').dispatchEvent(new pg.w.MouseEvent("click", { bubbles: true }));
  await waitFor(() => pg.text("#sheetTitle") === "PA-7", { what: "chart" });
  pg.d.getElementById("sheetClose").click();
  await waitFor(() => !/Loading/.test(pg.text("#newsList") + pg.text("#chartbox")), { what: "settled" }).catch(() => {});
  pg.d.getElementById("mapBack").click();
  assert.equal(pg.text("#mapCrumb"), "");
  assert.ok(pg.d.querySelectorAll("#mapWrap path[data-key]").length > 250, "back to the national view");
});

test("a redrawn state without shapes shows one tile per district", async (t) => {
  const pg = page(t);
  await loaded(pg);
  await waitFor(() => pg.d.querySelector('#mapWrap path[data-st="CA"]'), { what: "map" });
  pg.d.querySelector('#mapWrap path[data-st="CA"]').dispatchEvent(new pg.w.MouseEvent("click", { bubbles: true }));
  await waitFor(() => pg.d.querySelectorAll("#mapTiles .tile2").length === 52, { what: "52 tiles" });
  assert.match(pg.text("#mapInfo"), /New 2026 district lines/);
  assert.match(pg.d.querySelector('#mapTiles [data-key="CA-22"]').className, /t-none/);
});
