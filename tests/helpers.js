// Test helpers: a fake Kalshi built from small fixtures, and a loader that runs the real page
// (index.html + core.js) in jsdom with the real server functions behind /api/snapshot.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const ROOT = path.join(__dirname, "..");
const KALSHI = "https://api.elections.kalshi.com/trade-api/v2";

// ---------- Fixture builders ----------
function market(ticker, name, p, { vol24 = 60000, prev = p } = {}) {
  return {
    ticker, yes_sub_title: name, status: "active",
    yes_bid_dollars: (p - 0.005).toFixed(4), yes_ask_dollars: (p + 0.005).toFixed(4),
    last_price_dollars: p.toFixed(4), previous_price_dollars: prev.toFixed(4),
    volume_24h_fp: String(vol24), volume_fp: "900000",
  };
}
// Two-party race: D win chance pD. Suffixes default to -D / -R (Kalshi also uses -DEM / -GOP).
function twoParty(eventTicker, dName, rName, pD, opts = {}) {
  const [ds, rs] = opts.suffixes || ["D", "R"];
  return {
    event_ticker: eventTicker,
    markets: [market(`${eventTicker}-${ds}`, dName, pD, opts), market(`${eventTicker}-${rs}`, rName, 1 - pD, opts)],
  };
}

// The default fixture: a small but realistic slice of the 2026 board.
function defaultBoard() {
  const ev = {
    CONTROLS: [twoParty("CONTROLS-2026", "Democratic Party", "Republican Party", 0.67), twoParty("CONTROLS-2028", "Democratic Party", "Republican Party", 0.5)],
    CONTROLH: [twoParty("CONTROLH-2026", "Democratic Party", "Republican Party", 0.91)],
    SENATETX: [twoParty("SENATETX-26", "James Talarico", "Ken Paxton", 0.68)],
    SENATEGA: [twoParty("SENATEGA-26", "Jon Ossoff", "Mike Collins", 0.8)],
    SENATEME: [twoParty("SENATEME-26", "Graham Platner", "Susan Collins", 0.55)],
    SENATEOH: [], // listed but no open 2026 event
    SENATEOHS: [twoParty("SENATEOHS-26", "Sherrod Brown", "Jon Husted", 0.27)],
    // Alaska: a busy market and a thin duplicate for the same race
    SENATEAK: [twoParty("SENATEAK-26", "Democratic party", "Republican party", 0.69), twoParty("SENATEAK-26B", "Democratic party", "Republican party", 0.36, { vol24: 900 })],
    KXSENATEAK: [twoParty("KXSENATEAK-26", "Mary Peltola", "Dan Sullivan", 0.6)], // lower-preference series, should lose
    // Nebraska: three-way race with a strong independent
    SENATENE: [{ event_ticker: "SENATENE-26", markets: [market("SENATENE-26-R", "Pete Ricketts", 0.72), market("SENATENE-26-I", "Dan Osborn", 0.29), market("SENATENE-26-D", "Cindy Burbank", 0.003)] }],
    GOVPARTYAZ: [twoParty("GOVPARTYAZ-26", "Katie Hobbs", "Andy Biggs", 0.9)],
    GOVPARTYKY: [twoParty("GOVPARTYKY-27", "Democratic party", "Republican party", 0.2)], // 2027: must not show
    HOUSEPA7: [twoParty("HOUSEPA7-26", "Bob Brooks", "Ryan Mackenzie", 0.85)],
    HOUSEAKAL: [twoParty("HOUSEAKAL-26", "Mary Peltola", "Nick Begich", 0.4)],
    KXHOUSENC11: [twoParty("KXHOUSENC11-26", "Jamie Ager", "Jennifer Balkcom", 0.87, { suffixes: ["DEM", "GOP"] })],
    KXDHOUSESEATS: [{
      event_ticker: "KXDHOUSESEATS-27",
      markets: [["Below 210", 0.02], ["210-213", 0.02], ["214-217", 0.04], ["218-221", 0.06], ["222-225", 0.08], ["226-229", 0.1], ["230-233", 0.13],
        ["234-237", 0.15], ["238-241", 0.15], ["242-245", 0.11], ["246-249", 0.08], ["250-253", 0.04], ["Above 253", 0.02]]
        .map(([l, p], i) => market(`KXDHOUSESEATS-27-${i}`, l, p)),
    }],
    KXNYCCOUNCIL8: [twoParty("KXNYCCOUNCIL8-26", "A", "B", 0.5)], // not a race we track
  };
  return { events: ev, candles: null };
}

// ---------- Fake Kalshi ----------
// board.candles(ticker, unixSeconds) -> price, or null for "no history".
function fakeKalshi(board, log = []) {
  return async function handle(url) {
    const u = new URL(url);
    const p = u.pathname.replace("/trade-api/v2", "");
    log.push(p + u.search);
    const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(body)), text: async () => JSON.stringify(body) });
    if (board.fail && board.fail(p, u)) return json({ error: "nope" }, board.failStatus || 500);
    if (p === "/exchange/status") return json({ exchange_active: true });
    if (p === "/series") return json({ series: Object.keys(board.events).map((t) => ({ ticker: t, title: t })) });
    if (p === "/events") {
      const evs = board.events[u.searchParams.get("series_ticker")] || [];
      const nested = u.searchParams.get("with_nested_markets") === "true";
      return json({ events: evs.map((e) => (nested ? e : { event_ticker: e.event_ticker })) });
    }
    if (p === "/markets") {
      if (board.noBatch) return json({ markets: [] });
      const want = new Set((u.searchParams.get("tickers") || "").split(",").filter(Boolean));
      const out = [];
      for (const evs of Object.values(board.events)) for (const e of evs) for (const m of e.markets) if (want.has(m.ticker)) out.push({ ...m, event_ticker: e.event_ticker });
      return json({ markets: out });
    }
    const cm = p.match(/^\/series\/([^/]+)\/markets\/([^/]+)\/candlesticks$/);
    if (cm) {
      const tk = cm[2], s0 = +u.searchParams.get("start_ts"), e0 = +u.searchParams.get("end_ts"), per = +u.searchParams.get("period_interval") * 60;
      const now = Math.floor(Date.now() / 1000), c = [];
      if (board.candles) for (let t = Math.ceil(s0 / per) * per; t <= Math.min(e0, now); t += per) {
        const v = board.candles(tk, t);
        if (v == null) continue;
        c.push({ end_period_ts: t, price: { close_dollars: v.toFixed(4) }, yes_bid: { close_dollars: (v - 0.005).toFixed(4) }, yes_ask: { close_dollars: (v + 0.005).toFixed(4) } });
      }
      return json({ candlesticks: c });
    }
    return json({ error: "unknown path " + p }, 404);
  };
}

// Point Node's global fetch (used by the server functions) at the fake Kalshi.
function useFakeKalshi(board, log) {
  const handle = fakeKalshi(board, log);
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => (String(url).startsWith(KALSHI) ? handle(String(url)) : realFetch(url, opts));
  return () => { global.fetch = realFetch; };
}

// Call a Vercel-style handler (module.exports = (req,res)=>...) and capture the response.
async function callHandler(handler, query = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, end() { return this; } };
  await handler({ method: "GET", query, headers: {} }, res);
  return res;
}

// ---------- Page loader ----------
// opts.snapshot: "ok" (default) | "fail" | "slow" ; opts.storage: localStorage seed ; opts.board
function loadPage(opts = {}) {
  const board = opts.board || defaultBoard();
  const log = opts.log || [];
  const kalshi = fakeKalshi(board, log);
  const snapshotHandler = require(path.join(ROOT, "api/snapshot.js"));
  const errors = [];
  let html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  // Inline the page's own script files (core.js, house2024.js, ...)
  html = html.replace(/<script src="([\w.-]+\.js)"><\/script>/g, (_, f) => `<script>${fs.readFileSync(path.join(ROOT, f), "utf8")}</script>`);

  const restore = useFakeKalshi(board, log);
  let releaseSnapshot = null;
  const pageFetch = async (url) => {
    const u = String(url);
    const resp = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, json: async () => JSON.parse(JSON.stringify(body)) });
    if (u.startsWith("/api/snapshot")) {
      log.push("PAGE /api/snapshot");
      if (opts.snapshot === "fail") return resp(502, { error: "down" });
      if (opts.snapshot === "slow") await new Promise((r) => { releaseSnapshot = r; });
      const r = await callHandler(snapshotHandler);
      return resp(r.statusCode, r.body);
    }
    if (u.startsWith("/api/kalshi?path=")) {
      log.push("PAGE /api/kalshi " + decodeURIComponent(u.slice("/api/kalshi?path=".length)).split("?")[0]);
      return kalshi(KALSHI + decodeURIComponent(u.slice("/api/kalshi?path=".length)));
    }
    return resp(404, {});
  };

  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true, url: "https://tracker.test/",
    beforeParse(w) {
      w.fetch = pageFetch;
      w.navigator.wakeLock = { request: async () => ({ release: async () => {} }) };
      for (const [k, v] of Object.entries(opts.storage || {})) w.localStorage.setItem(k, JSON.stringify(v));
      w.console.error = (...a) => errors.push(a.join(" "));
    },
  });
  dom.window.addEventListener("error", (e) => errors.push(e.message));
  const d = dom.window.document;
  const text = (sel) => (d.querySelector(sel)?.textContent || "").replace(/\s+/g, " ").trim();
  const rows = () => [...d.querySelectorAll(".row[data-id]")];
  const row = (id) => d.querySelector(`.row[data-id="${id}"]`);
  return {
    dom, d, w: dom.window, log, errors, board, text, rows, row,
    release: () => releaseSnapshot && releaseSnapshot(),
    close() { dom.window.close(); restore(); },
  };
}

async function waitFor(fn, { timeout = 8000, step = 25, what = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = fn(); } catch (e) { v = false; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error("Timed out waiting for " + what);
    await new Promise((r) => setTimeout(r, step));
  }
}
const loaded = (pg) => waitFor(() => pg.rows().length > 0 && /Updated/.test(pg.text("#updated")), { what: "first refresh" });

module.exports = { market, twoParty, defaultBoard, fakeKalshi, useFakeKalshi, callHandler, loadPage, waitFor, loaded, ROOT };
