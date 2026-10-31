// Race news: the headline parser and the news list in a race's chart.
const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultBoard, loadPage, waitFor, loaded } = require("./helpers.js");
const { parseFeed } = require("../api/news.js");

const rss = (items) => `<?xml version="1.0"?><rss><channel>${items.map((i) =>
  `<item><title>${i.title}</title><link>${i.link || "https://example.com/" + encodeURIComponent(i.title)}</link><pubDate>${new Date(i.at).toUTCString()}</pubDate><source url="https://x">${i.source}</source></item>`).join("")}</channel></rss>`;

test("parses Google News headlines: strips the source suffix, newest first, no duplicates", () => {
  const now = Date.now();
  const items = parseFeed(rss([
    { title: "Paxton gains in new poll - Texas Tribune", source: "Texas Tribune", at: now - 3 * 3600e3 },
    { title: "Talarico &amp; Paxton debate - AP News", source: "AP News", at: now - 3600e3 },
    { title: "Paxton gains in new poll - Texas Tribune", source: "Texas Tribune", at: now - 5 * 3600e3 },
    { title: "Bad link", source: "X", at: now, link: "javascript:alert(1)" },
  ]));
  assert.deepEqual(items.map((i) => i.title), ["Talarico & Paxton debate", "Paxton gains in new poll"]);
  assert.equal(items[0].source, "AP News");
});

test("a race's chart lists recent headlines and marks them on the chart", async (t) => {
  const board = defaultBoard();
  const now = Date.now();
  board.candles = (tk, ts) => (tk.endsWith("-D") ? 0.6 : 0.4);
  board.news = (q) => (/Paxton/.test(q) ? rss([{ title: "Paxton surges after debate - Houston Chronicle", source: "Houston Chronicle", at: now - 2 * 3600e3 }]) : rss([]));
  const pg = loadPage({ board });
  t.after(() => pg.close());
  await loaded(pg);
  pg.row("SENATETX-26").click();
  await waitFor(() => /Paxton surges after debate/.test(pg.text("#newsList")), { what: "headline" });
  assert.match(pg.text("#newsList"), /2h ago/);
  assert.ok(pg.log.some((l) => /^NEWS "James Talarico" OR "Ken Paxton" Senate/.test(l) || /^NEWS "Ken Paxton" OR "James Talarico" Senate/.test(l)), "searches both candidates");
  await waitFor(() => pg.d.querySelectorAll("#chartbox svg title").length === 1, { what: "chart marker" });
  // Party-labeled markets (Alaska) search the state and office instead
  pg.d.getElementById("sheetClose").click();
  pg.row("SENATEAK-26").click();
  await waitFor(() => pg.log.some((l) => l.startsWith('NEWS "Alaska" Senate race')), { what: "Alaska search" });
  await waitFor(() => !/Loading/.test(pg.text("#chartbox")) && !/Loading/.test(pg.text("#newsList")), { what: "Alaska chart loaded" });
  assert.deepEqual(pg.errors, []);
});

test("news can be switched off, and stays off", async (t) => {
  const board = defaultBoard();
  board.news = () => rss([{ title: "Something happened - AP", source: "AP", at: Date.now() - 600e3 }]);
  const pg = loadPage({ board });
  t.after(() => pg.close());
  await loaded(pg);
  pg.row("SENATEGA-26").click();
  await waitFor(() => /Something happened/.test(pg.text("#newsList")), { what: "headline" });
  pg.d.getElementById("newsToggle").click();
  assert.match(pg.text("#newsList"), /News is off/);
  assert.equal(JSON.parse(pg.w.localStorage.getItem("et.ui")).news, false);
  pg.d.getElementById("sheetClose").click();
  const before = pg.log.filter((l) => l.startsWith("NEWS")).length;
  pg.row("SENATETX-26").click();
  await waitFor(() => !/Loading/.test(pg.text("#chartbox")), { what: "chart loaded" });
  assert.equal(pg.log.filter((l) => l.startsWith("NEWS")).length, before, "no news lookups while off");
  assert.match(pg.text("#newsList"), /News is off/);
});
