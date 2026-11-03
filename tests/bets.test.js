// The private positions board: key check, settings parsing, and pricing against a fake Kalshi.
const test = require("node:test");
const assert = require("node:assert/strict");
const { defaultBoard, useFakeKalshi, callHandler } = require("./helpers.js");
const bets = require("../api/bets.js");

const KEY = "test-key-0123456789abcdef";
function withEnv(env, fn) {
  return async () => {
    const old = { BETS_KEY: process.env.BETS_KEY, BETS_POSITIONS: process.env.BETS_POSITIONS };
    Object.assign(process.env, env);
    const restore = useFakeKalshi(defaultBoard(), []);
    try { await fn(); } finally {
      restore();
      for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}
const POS = JSON.stringify([
  { t: "SENATETX-26-D", side: "yes", n: 20, cost: 12, label: "TX Sen: Talarico", group: "Senate" },
  { t: "GOVPARTYAZ-26-R", side: "no", n: 10, cost: 8, label: "AZ Gov: Biggs loses", group: "Governor" },
  { t: "NOPE-1", side: "yes", n: 5, cost: 2, label: "Gone", group: "Other" },
]);

test("bets: wrong or missing key looks like a missing page", withEnv({ BETS_KEY: KEY, BETS_POSITIONS: POS }, async () => {
  for (const q of [{}, { k: "" }, { k: "wrong" }, { k: KEY + "x" }]) {
    const res = await callHandler(bets, q);
    assert.equal(res.statusCode, 404);
    assert.equal(res.headers["cache-control"], "no-store");
  }
}));

test("bets: refuses to open with a short or unset key", withEnv({ BETS_KEY: "short", BETS_POSITIONS: POS }, async () => {
  const res = await callHandler(bets, { k: "short" });
  assert.equal(res.statusCode, 404);
}));

test("bets: prices each position on its own side, totals add up", withEnv({ BETS_KEY: KEY, BETS_POSITIONS: POS }, async () => {
  const res = await callHandler(bets, { k: KEY });
  assert.equal(res.statusCode, 200);
  const [tx, az, gone] = res.body.rows;
  assert.ok(Math.abs(tx.price - 0.68) < 1e-9, "yes side = yes midpoint");
  assert.ok(Math.abs(az.price - 0.9) < 1e-9, "no side = 1 - yes");   // Biggs yes ~0.10
  assert.equal(tx.value, 13.6);
  assert.equal(gone.price, null, "unknown ticker has no price");
  assert.equal(res.body.totals.cost, 22);
  assert.equal(res.body.totals.payout, 35);
  assert.equal(res.body.totals.priced, 2);
}));

test("bets: settled markets pay 1 or 0", () => {
  assert.equal(bets.sideValue({ result: "no" }, "no"), 1);
  assert.equal(bets.sideValue({ result: "no" }, "yes"), 0);
  assert.equal(bets.sideValue({ yes_bid_dollars: "0.30", yes_ask_dollars: "0.70", last_price_dollars: "0.44" }, "no"), 0.56, "wide spread uses last trade");
});

test("bets: bad settings JSON is reported, not crashed on", withEnv({ BETS_KEY: KEY, BETS_POSITIONS: "{oops" }, async () => {
  const res = await callHandler(bets, { k: KEY });
  assert.equal(res.statusCode, 500);
}));

// ---------- Live positions from the Kalshi account ----------
const crypto = require("crypto");

// A fake Kalshi account that checks every signature with the matching public key
function withAccount({ keyType = "rsa", pemTransform = (x) => x, keyId = "8f2a1c3e-1111-4a2b-9c3d-0123456789ab", positions, status = 200, saved = POS }, fn) {
  return async () => {
    const pair = keyType === "rsa"
      ? crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
      : crypto.generateKeyPairSync("ed25519");
    const pem = pair.privateKey.export({ type: keyType === "rsa" ? "pkcs1" : "pkcs8", format: "pem" });
    const names = ["BETS_KEY", "BETS_POSITIONS", "KALSHI_KEY_ID", "KALSHI_PRIVATE_KEY"];
    const old = Object.fromEntries(names.map((k) => [k, process.env[k]]));
    Object.assign(process.env, { BETS_KEY: KEY, BETS_POSITIONS: saved, KALSHI_KEY_ID: keyId, KALSHI_PRIVATE_KEY: pemTransform(pem) });
    const restore = useFakeKalshi(defaultBoard(), []);
    const inner = global.fetch, seen = [];
    global.fetch = async (url, opts) => {
      const u = new URL(String(url));
      if (u.pathname === "/trade-api/v2/portfolio/positions") {
        const h = (opts && opts.headers) || {};
        const msg = Buffer.from(h["KALSHI-ACCESS-TIMESTAMP"] + "GET" + u.pathname);
        const sig = Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64");
        const ok = keyType === "rsa"
          ? crypto.verify("sha256", msg, { key: pair.publicKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST }, sig)
          : crypto.verify(null, msg, pair.publicKey, sig);
        seen.push({ ok, keyId: h["KALSHI-ACCESS-KEY"], search: u.search });
        const body = ok ? { market_positions: positions, cursor: "" } : { error: "bad sig" };
        const st = ok ? status : 401;
        return { ok: st < 400, status: st, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) };
      }
      return inner(url, opts);
    };
    try { await fn(seen); } finally {
      global.fetch = inner; restore();
      for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  };
}

const LIVE = [
  { ticker: "SENATETX-26-D", position_fp: "20.00", market_exposure_dollars: "13.0000" },   // same as saved: keeps saved label and cost
  { ticker: "GOVPARTYAZ-26-R", position_fp: "-15.00", market_exposure_dollars: "12.5000" }, // added to: account cost
  { ticker: "SENATEOHS-26-D", position_fp: "4.00", market_exposure_dollars: "2.8000" },     // new bet, not in saved list
];

test("bets: reads live positions from the account with a valid RSA signature", withAccount({ positions: LIVE }, async (seen) => {
  const res = await callHandler(bets, { k: KEY });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, "account");
  assert.ok(seen.length >= 1 && seen.every((s) => s.ok && s.keyId === "8f2a1c3e-1111-4a2b-9c3d-0123456789ab"), "signed with the key id");
  assert.match(seen[0].search, /count_filter=position/);
  const byT = Object.fromEntries(res.body.rows.map((r) => [r.ticker, r]));
  assert.equal(res.body.rows.length, 3, "sold/closed saved positions drop off");
  assert.equal(byT["SENATETX-26-D"].label, "TX Sen: Talarico");
  assert.equal(byT["SENATETX-26-D"].cost, 12, "unchanged holding keeps the saved cost");
  assert.equal(byT["GOVPARTYAZ-26-R"].side, "no");
  assert.equal(byT["GOVPARTYAZ-26-R"].contracts, 15);
  assert.equal(byT["GOVPARTYAZ-26-R"].cost, 12.5, "changed holding uses the account cost");
  assert.equal(byT["SENATEOHS-26-D"].group, "Senate", "new bet gets a race type from its ticker");
  assert.ok(byT["SENATEOHS-26-D"].label && byT["SENATEOHS-26-D"].label !== "SENATEOHS-26-D", "new bet gets a name from Kalshi");
}));

test("bets: Ed25519 keys sign too", withAccount({ keyType: "ed25519", positions: LIVE }, async (seen) => {
  const res = await callHandler(bets, { k: KEY });
  assert.equal(res.body.source, "account");
  assert.ok(seen[0].ok);
}));

test("bets: a key pasted on one line with \\n escapes still works", withAccount({ positions: LIVE, pemTransform: (p) => p.trim().replace(/\n/g, "\\n") }, async () => {
  const res = await callHandler(bets, { k: KEY });
  assert.equal(res.body.source, "account");
}));

test("bets: a key squashed onto one line with spaces still works", withAccount({ positions: LIVE, pemTransform: (p) => p.trim().replace(/\n/g, " ") }, async () => {
  const res = await callHandler(bets, { k: KEY });
  assert.equal(res.body.source, "account");
}));

test("bets: if the account call fails, falls back to the saved list", withAccount({ positions: LIVE, status: 401 }, async () => {
  const res = await callHandler(bets, { k: KEY });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, "saved");
  assert.match(res.body.accountError, /401/);
  assert.match(res.body.accountError, /external-api/, "tries the newer host too");
  assert.equal(res.body.rows.length, 3);
  assert.equal(res.body.rows[0].label, "TX Sen: Talarico");
}));

test("bets: an unreadable private key falls back without leaking it", withAccount({ positions: LIVE, pemTransform: () => "not a key at all" }, async () => {
  const res = await callHandler(bets, { k: KEY });
  assert.equal(res.body.source, "saved");
  assert.ok(!/not a key/.test(JSON.stringify(res.body)), "key text never echoed");
}));

test("bets: a Key ID saved with quotes around it still works", withAccount({ positions: LIVE, keyId: '"8f2a1c3e-1111-4a2b-9c3d-0123456789ab"' }, async (seen) => {
  const res = await callHandler(bets, { k: KEY });
  assert.equal(res.body.source, "account");
  assert.equal(seen[0].keyId, "8f2a1c3e-1111-4a2b-9c3d-0123456789ab", "quotes stripped before sending");
}));

// ---------- Parlay legs ----------
const { market } = require("./helpers.js");

function parlayBoard() {
  const b = defaultBoard();
  b.events.KXMVECROSSCATEGORY = [{
    event_ticker: "KXMVECROSSCATEGORY-S2026TEST",
    markets: [{
      ...market("KXMVECROSSCATEGORY-S2026TEST-ABC", "parlay", 0.3),
      yes_bid_dollars: "0.0000", yes_ask_dollars: "1.0000", last_price_dollars: "0.3000",
      mve_selected_legs: [
        { event_ticker: "SENATETX-26", market_ticker: "SENATETX-26-D", side: "yes" },
        { event_ticker: "GOVPARTYAZ-26", market_ticker: "GOVPARTYAZ-26-D", side: "yes" },
        { event_ticker: "CONTROLH-2026", market_ticker: "CONTROLH-2026-D", side: "yes" },
        { event_ticker: "SENATEOHS-26", market_ticker: "SENATEOHS-26-R", side: "no" },
      ],
    }],
  }];
  // Ohio moved overnight: yesterday Husted was 0.80, today 0.73
  const oh = b.events.SENATEOHS[0].markets.find((m) => m.ticker === "SENATEOHS-26-R");
  oh.previous_price_dollars = "0.8000";
  return b;
}

test("bets: parlays come with every leg priced on the side the parlay needs", async () => {
  const old = { BETS_KEY: process.env.BETS_KEY, BETS_POSITIONS: process.env.BETS_POSITIONS };
  process.env.BETS_KEY = KEY;
  process.env.BETS_POSITIONS = JSON.stringify([{ t: "KXMVECROSSCATEGORY-S2026TEST-ABC", side: "yes", n: 100, cost: 30, label: "4-leg parlay", group: "Parlay" }]);
  const restore = useFakeKalshi(parlayBoard(), []);
  try {
    const res = await callHandler(bets, { k: KEY });
    const r = res.body.rows[0];
    assert.equal(r.legs.length, 4);
    const by = Object.fromEntries(r.legs.map((l) => [l.race, l]));
    assert.equal(by["TX Sen"].name, "James Talarico");
    assert.ok(Math.abs(by["TX Sen"].price - 0.68) < 1e-9);
    assert.equal(by["House control"].name, "Democrats");
    assert.equal(by["OH Sen (special)"].name, "Not Jon Husted");
    assert.ok(Math.abs(by["OH Sen (special)"].price - 0.27) < 1e-9, "no side = 1 - yes");
    assert.ok(Math.abs(by["OH Sen (special)"].prev - 0.2) < 1e-9, "trend baseline is on the leg's side too");
    assert.equal(r.legsAhead, 3);
    assert.ok(Math.abs(r.legsCombined - 0.68 * 0.9 * 0.91 * 0.27) < 1e-9);
  } finally {
    restore();
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("bets: page shows a parlay's legs weakest first, and keeps the list open across refreshes", async () => {
  const fs = require("fs"), path = require("path");
  const { JSDOM } = require("jsdom");
  const html = fs.readFileSync(path.join(__dirname, "..", "bets.html"), "utf8");
  const body = {
    at: Date.now(), source: "account", accountError: null,
    totals: { cost: 30, value: 30, payout: 100, priced: 1, count: 1 },
    rows: [{ ticker: "P1", label: "4-leg parlay", group: "Parlay", side: "yes", contracts: 100, cost: 30, price: 0.3, value: 30, payout: 100, status: "active", result: null,
      legs: [
        { ticker: "a", race: "TX Sen", name: "James Talarico", side: "yes", price: 0.68, prev: 0.6, result: null },
        { ticker: "b", race: "OH Sen (special)", name: "Not Jon Husted", side: "no", price: 0.27, prev: 0.2, result: null },
        { ticker: "c", race: "House control", name: "Democrats", side: "yes", price: 1, prev: 0.9, result: "yes" },
      ], legsCombined: 0.18, legsAhead: 2, legsWon: 1, legsLost: 0 }],
  };
  const dom = new JSDOM(html, {
    url: "https://x.test/bets.html?k=secret", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) { w.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }); },
  });
  const doc = dom.window.document;
  const wait = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(fn()); };
  await wait(() => doc.querySelector(".legs"));
  const names = [...doc.querySelectorAll(".leg .who")].map((e) => e.textContent);
  assert.match(names[0], /Husted/, "weakest leg first");
  assert.match(doc.querySelector(".legs summary").textContent, /2\/3 legs ahead/);
  assert.match(doc.querySelector(".legs summary").textContent, /weakest: OH Sen \(special\) 27¢/);
  assert.ok(doc.querySelector(".leg.won"), "settled leg marked won");
  assert.match(doc.querySelectorAll(".leg .tr")[0].textContent, /▲7¢/);
  // open it, refresh, still open
  const d = doc.querySelector(".legs");
  d.open = true; d.dispatchEvent(new dom.window.Event("toggle"));
  doc.getElementById("refresh").click();
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(doc.querySelector(".legs").open, "stays open after refresh");
  dom.window.close();
});

// ---------- Hedge helper ----------
function renderBoard(body) {
  const fs = require("fs"), path = require("path");
  const { JSDOM } = require("jsdom");
  const html = fs.readFileSync(path.join(__dirname, "..", "bets.html"), "utf8");
  const dom = new JSDOM(html, {
    url: "https://x.test/bets.html?k=secret", runScripts: "dangerously", pretendToBeVisual: true,
    beforeParse(w) { w.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) }); },
  });
  return dom;
}
const waitFor2 = async (fn) => { for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 20)); assert.ok(fn()); };
const leg = (o) => ({ ticker: o.race, side: "yes", result: null, prev: null, hedgeSide: "no", hedgeName: "Not " + o.race, url: "https://kalshi.com/markets/x/m/x-26", ...o });
const parlayRow = (legs) => ({ ticker: "P", label: "parlay", group: "Parlay", side: "yes", contracts: 292.91, cost: 100, price: 0.3, value: 88, payout: 292.91, status: "active", result: null,
  legs, legsCombined: 0.5, legsAhead: legs.length, legsWon: legs.filter((l) => l.price === 1).length, legsLost: 0 });
const boardBody = (rows) => ({ at: Date.now(), source: "account", accountError: null, totals: { cost: 100, value: 88, payout: 292.91, priced: 1, count: 1 }, rows });

test("bets: hedge helper locks in a parlay with two legs left, with Kalshi buttons", async () => {
  const legs = [leg({ race: "A", price: 1 }), leg({ race: "B", price: 1 }), leg({ race: "TX Sen", price: 0.7, hedgeAsk: 0.3 }), leg({ race: "OH Sen", price: 0.72, hedgeAsk: 0.28 })];
  const dom = renderBoard(boardBody([parlayRow(legs)]));
  const doc = dom.window.document;
  await waitFor2(() => doc.querySelector(".lock"));
  const box = doc.querySelector(".lock").textContent;
  // 293 contracts of each hedge: 87.90 + 4.31 fee, 82.04 + 4.14 fee = 178.39; locked 292.91 - 178.39 = 114.52
  assert.match(box, /2 legs left/);
  assert.match(box, /293 contracts at ~30¢ ≈ \$92\.21/);
  assert.match(box, /293 contracts at ~28¢ ≈ \$86\.18/);
  assert.match(box, /Spend ≈ \$178\.39/);
  assert.match(box, /at least \$114\.52/);
  assert.match(box, /\+\$14\.52 vs the \$100\.00 you paid/);
  const links = [...doc.querySelectorAll(".lock a.kl")];
  assert.equal(links.length, 2);
  assert.equal(links[0].getAttribute("href"), "https://kalshi.com/markets/x/m/x-26");
  assert.equal(links[0].getAttribute("target"), "_blank");
  dom.window.close();
});

test("bets: hedge helper waits with 3+ legs open, and stands down once a leg has lost", async () => {
  let dom = renderBoard(boardBody([parlayRow([leg({ race: "A", price: 0.7, hedgeAsk: 0.3 }), leg({ race: "B", price: 0.7, hedgeAsk: 0.3 }), leg({ race: "C", price: 0.7, hedgeAsk: 0.3 })])]));
  await waitFor2(() => dom.window.document.querySelector(".waitlock"));
  assert.match(dom.window.document.querySelector(".waitlock").textContent, /appears when 2 legs are left \(3 open now\)/);
  assert.equal(dom.window.document.querySelector(".lock"), null);
  dom.window.close();
  dom = renderBoard(boardBody([parlayRow([leg({ race: "A", price: 0 }), leg({ race: "B", price: 0.7, hedgeAsk: 0.3 })])]));
  await waitFor2(() => dom.window.document.querySelector(".waitlock"));
  assert.match(dom.window.document.querySelector(".waitlock").textContent, /can't pay/);
  dom.window.close();
});

test("bets: Kalshi links and hedge prices come from the market data", () => {
  assert.equal(bets.kalshiUrl("CONTROLS-2026"), "https://kalshi.com/markets/controls/m/controls-2026");
  assert.equal(bets.kalshiUrl("KXMIDTERMMOV-MSSENR"), "https://kalshi.com/markets/kxmidtermmov/midterm-margin-of-victory/kxmidtermmov-mssenr");
  assert.equal(bets.oppositeAsk({ no_ask_dollars: "0.3000" }, "yes"), 0.3);
  assert.equal(bets.oppositeAsk({ yes_ask_dollars: "0.2500" }, "no"), 0.25);
  assert.equal(bets.oppositeAsk({ yes_bid_dollars: "0.7000", no_ask_dollars: "1.0000" }, "yes"), 0.3, "falls back to 1 - bid when no ask");
});
